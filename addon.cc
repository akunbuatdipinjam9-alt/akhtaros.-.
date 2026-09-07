// asus-wmi-addon
// Native N-API module buat manggil method DEVS/DSTS di class WMI
// "AsusAtkWmi_WMNB" (root\wmi) langsung lewat COM/IWbemServices,
// tanpa spawn proses powershell.exe kayak versi PowerShell di main.js.
//
// Kelebihan dibanding versi PowerShell:
//   - Jauh lebih cepet (gak ada overhead startup powershell.exe ~150-400ms)
//   - Error dari WMI keluar sebagai HRESULT asli, bukan teks stacktrace
//     yang harus di-parse manual
//   - Bisa jalan async lewat libuv worker thread (Napi::AsyncWorker),
//     jadi gak nge-block main process Electron
//
// WAJIB compile di Windows (butuh Visual Studio Build Tools + Windows SDK).
// Lihat README.md buat cara build-nya.

#include <napi.h>
#include <windows.h>
#include <wbemidl.h>
#include <comdef.h>
#include <string>
#include <vector>

#pragma comment(lib, "wbemuuid.lib")

namespace {

// -----------------------------------------------------------------
// Helper kecil: convert HRESULT jadi pesan yang manusiawi
// -----------------------------------------------------------------
std::string HResultToMessage(HRESULT hr) {
    _com_error ce(hr);
    std::wstring wmsg = ce.ErrorMessage();
    if (wmsg.empty()) return "HRESULT 0x" + std::to_string((unsigned long)hr);
    std::string msg(wmsg.begin(), wmsg.end());
    return msg;
}

struct WmiCallException {
    std::string message;
};

// -----------------------------------------------------------------
// Konek ke namespace ROOT\WMI, ambil instance pertama AsusAtkWmi_WMNB,
// terus panggil method (DEVS atau DSTS) dengan Device_ID + optional value.
// Semua di-throw sebagai WmiCallException kalau gagal di step manapun.
// Fungsi ini dipanggil dari thread worker (bukan main thread Node),
// jadi CoInitializeEx/CoUninitialize dipanggil per-call di sini.
// -----------------------------------------------------------------
long CallAsusWmiMethod(const wchar_t* methodName,
                        unsigned long deviceId,
                        bool hasValue,
                        bool valueIsBytes,
                        unsigned long intValue,
                        const std::vector<unsigned char>& bytesValue) {
    HRESULT hr;
    bool needCoUninit = false;

    hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (hr == S_OK || hr == S_FALSE) {
        needCoUninit = true;
    } else if (hr != RPC_E_CHANGED_MODE) {
        // RPC_E_CHANGED_MODE = thread ini udah di-init dengan apartment beda,
        // itu masih oke, cuma gak boleh kita yang CoUninitialize nanti.
        throw WmiCallException{ "CoInitializeEx gagal: " + HResultToMessage(hr) };
    }

    struct CoGuard {
        bool active;
        ~CoGuard() { if (active) CoUninitialize(); }
    } coGuard{ needCoUninit };

    // Security blanket process-wide. Kalau udah pernah di-set (misal sama
    // Electron/Chromium sendiri), CoInitializeSecurity bakal balikin
    // RPC_E_TOO_LATE — itu bukan error fatal, tinggal lanjut aja.
    hr = CoInitializeSecurity(nullptr, -1, nullptr, nullptr,
                               RPC_C_AUTHN_LEVEL_DEFAULT, RPC_C_IMP_LEVEL_IMPERSONATE,
                               nullptr, EOAC_NONE, nullptr);
    if (FAILED(hr) && hr != RPC_E_TOO_LATE) {
        throw WmiCallException{ "CoInitializeSecurity gagal: " + HResultToMessage(hr) };
    }

    IWbemLocator* pLoc = nullptr;
    hr = CoCreateInstance(CLSID_WbemLocator, 0, CLSCTX_INPROC_SERVER,
                           IID_IWbemLocator, (LPVOID*)&pLoc);
    if (FAILED(hr) || !pLoc) {
        throw WmiCallException{ "Gagal bikin IWbemLocator: " + HResultToMessage(hr) };
    }

    IWbemServices* pSvc = nullptr;
    hr = pLoc->ConnectServer(_bstr_t(L"ROOT\\WMI"), nullptr, nullptr, nullptr,
                              0, nullptr, nullptr, &pSvc);
    pLoc->Release();
    if (FAILED(hr) || !pSvc) {
        throw WmiCallException{ "Gagal konek ke namespace ROOT\\WMI: " + HResultToMessage(hr) };
    }

    hr = CoSetProxyBlanket(pSvc, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, nullptr,
                            RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, nullptr, EOAC_NONE);
    if (FAILED(hr)) {
        pSvc->Release();
        throw WmiCallException{ "Gagal set proxy blanket: " + HResultToMessage(hr) };
    }

    // Cari instance pertama dari class AsusAtkWmi_WMNB
    IEnumWbemClassObject* pEnum = nullptr;
    hr = pSvc->CreateInstanceEnum(_bstr_t(L"AsusAtkWmi_WMNB"), WBEM_FLAG_SHALLOW, nullptr, &pEnum);
    if (FAILED(hr) || !pEnum) {
        pSvc->Release();
        throw WmiCallException{
            "Class AsusAtkWmi_WMNB gak ketemu — laptop ini kemungkinan bukan ASUS, "
            "atau driver ATK WMI-nya belum ke-install: " + HResultToMessage(hr)
        };
    }

    IWbemClassObject* pInst = nullptr;
    ULONG returned = 0;
    hr = pEnum->Next(WBEM_INFINITE, 1, &pInst, &returned);
    pEnum->Release();
    if (FAILED(hr) || returned == 0 || !pInst) {
        pSvc->Release();
        throw WmiCallException{ "Gak ada instance AsusAtkWmi_WMNB yang aktif." };
    }

    // Ambil __PATH & __CLASS instance ini
    VARIANT vPath, vClassName;
    VariantInit(&vPath);
    VariantInit(&vClassName);
    pInst->Get(L"__PATH", 0, &vPath, nullptr, nullptr);
    pInst->Get(L"__CLASS", 0, &vClassName, nullptr, nullptr);
    pInst->Release();

    // Ambil signature method (in-params template) dari class object
    IWbemClassObject* pClass = nullptr;
    hr = pSvc->GetObject(vClassName.bstrVal, 0, nullptr, &pClass, nullptr);
    VariantClear(&vClassName);
    if (FAILED(hr) || !pClass) {
        VariantClear(&vPath);
        pSvc->Release();
        throw WmiCallException{ "Gagal ambil class object: " + HResultToMessage(hr) };
    }

    IWbemClassObject* pInParamsDef = nullptr;
    hr = pClass->GetMethod(methodName, 0, &pInParamsDef, nullptr);
    pClass->Release();
    if (FAILED(hr) || !pInParamsDef) {
        VariantClear(&vPath);
        pSvc->Release();
        std::wstring wname(methodName);
        std::string name(wname.begin(), wname.end());
        throw WmiCallException{ "Method '" + name + "' gak ada di class ini: " + HResultToMessage(hr) };
    }

    IWbemClassObject* pInParams = nullptr;
    pInParamsDef->SpawnInstance(0, &pInParams);
    pInParamsDef->Release();

    // Device_ID
    VARIANT vDevId;
    VariantInit(&vDevId);
    vDevId.vt = VT_UI4;
    vDevId.ulVal = deviceId;
    pInParams->Put(L"Device_ID", 0, &vDevId, 0);
    VariantClear(&vDevId);

    // Control_status (cuma dikirim buat DEVS, DSTS gak butuh ini)
    if (hasValue) {
        if (valueIsBytes) {
            SAFEARRAY* sa = SafeArrayCreateVector(VT_UI1, 0, (ULONG)bytesValue.size());
            for (LONG i = 0; i < (LONG)bytesValue.size(); i++) {
                unsigned char b = bytesValue[(size_t)i];
                SafeArrayPutElement(sa, &i, &b);
            }
            VARIANT vBytes;
            VariantInit(&vBytes);
            vBytes.vt = VT_ARRAY | VT_UI1;
            vBytes.parray = sa;
            pInParams->Put(L"Control_status", 0, &vBytes, 0);
            VariantClear(&vBytes); // ini juga ngedestroy SAFEARRAY-nya
        } else {
            VARIANT vVal;
            VariantInit(&vVal);
            vVal.vt = VT_UI4;
            vVal.ulVal = intValue;
            pInParams->Put(L"Control_status", 0, &vVal, 0);
            VariantClear(&vVal);
        }
    }

    IWbemClassObject* pOutParams = nullptr;
    hr = pSvc->ExecMethod(vPath.bstrVal, _bstr_t(methodName), 0, nullptr, pInParams, &pOutParams, nullptr);
    VariantClear(&vPath);
    pInParams->Release();
    pSvc->Release();

    if (FAILED(hr)) {
        if (pOutParams) pOutParams->Release();
        throw WmiCallException{ "ExecMethod " + std::string(methodName == std::wstring(L"DEVS") ? "DEVS" : "DSTS")
            + " gagal (firmware nolak / method gak didukung): " + HResultToMessage(hr) };
    }

    long resultVal = -1;
    if (pOutParams) {
        VARIANT vResult;
        VariantInit(&vResult);
        hr = pOutParams->Get(L"result", 0, &vResult, nullptr, nullptr);
        if (SUCCEEDED(hr) && vResult.vt != VT_NULL) {
            resultVal = vResult.lVal;
        }
        VariantClear(&vResult);
        pOutParams->Release();
    }

    return resultVal;
}

// -----------------------------------------------------------------
// AsyncWorker: jalan di libuv worker thread, gak nge-block main thread
// Electron/Node. Dipakai buat semua 3 operasi (devsInt, devsBytes, dsts).
// -----------------------------------------------------------------
class AsusWmiWorker : public Napi::AsyncWorker {
public:
    AsusWmiWorker(Napi::Env env, Napi::Promise::Deferred deferred,
                  std::wstring method, unsigned long deviceId,
                  bool hasValue, bool valueIsBytes,
                  unsigned long intValue, std::vector<unsigned char> bytesValue)
        : Napi::AsyncWorker(env),
          deferred_(deferred),
          method_(std::move(method)),
          deviceId_(deviceId),
          hasValue_(hasValue),
          valueIsBytes_(valueIsBytes),
          intValue_(intValue),
          bytesValue_(std::move(bytesValue)),
          result_(-1) {}

    void Execute() override {
        try {
            result_ = CallAsusWmiMethod(method_.c_str(), deviceId_, hasValue_, valueIsBytes_, intValue_, bytesValue_);
        } catch (const WmiCallException& e) {
            SetError(e.message);
        } catch (const std::exception& e) {
            SetError(std::string("Exception gak terduga: ") + e.what());
        }
    }

    void OnOK() override {
        Napi::HandleScope scope(Env());
        deferred_.Resolve(Napi::Number::New(Env(), (double)result_));
    }

    void OnError(const Napi::Error& e) override {
        Napi::HandleScope scope(Env());
        deferred_.Reject(e.Value());
    }

private:
    Napi::Promise::Deferred deferred_;
    std::wstring method_;
    unsigned long deviceId_;
    bool hasValue_;
    bool valueIsBytes_;
    unsigned long intValue_;
    std::vector<unsigned char> bytesValue_;
    long result_;
};

// devsWrite(deviceId: number, value: number): Promise<number>
Napi::Value DevsWrite(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        deferred.Reject(Napi::TypeError::New(env, "devsWrite(deviceId: number, value: number)").Value());
        return deferred.Promise();
    }

    unsigned long deviceId = (unsigned long)info[0].As<Napi::Number>().Int64Value();
    unsigned long value = (unsigned long)info[1].As<Napi::Number>().Int64Value();

    auto* worker = new AsusWmiWorker(env, deferred, L"DEVS", deviceId, true, false, value, {});
    worker->Queue();
    return deferred.Promise();
}

// devsWriteBytes(deviceId: number, bytes: number[]): Promise<number>
Napi::Value DevsWriteBytes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsArray()) {
        deferred.Reject(Napi::TypeError::New(env, "devsWriteBytes(deviceId: number, bytes: number[])").Value());
        return deferred.Promise();
    }

    unsigned long deviceId = (unsigned long)info[0].As<Napi::Number>().Int64Value();
    Napi::Array arr = info[1].As<Napi::Array>();
    std::vector<unsigned char> bytes;
    bytes.reserve(arr.Length());
    for (uint32_t i = 0; i < arr.Length(); i++) {
        Napi::Value v = arr.Get(i);
        bytes.push_back((unsigned char)(v.As<Napi::Number>().Int32Value() & 0xFF));
    }

    auto* worker = new AsusWmiWorker(env, deferred, L"DEVS", deviceId, true, true, 0, bytes);
    worker->Queue();
    return deferred.Promise();
}

// dstsRead(deviceId: number): Promise<number>
Napi::Value DstsRead(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    if (info.Length() < 1 || !info[0].IsNumber()) {
        deferred.Reject(Napi::TypeError::New(env, "dstsRead(deviceId: number)").Value());
        return deferred.Promise();
    }

    unsigned long deviceId = (unsigned long)info[0].As<Napi::Number>().Int64Value();

    auto* worker = new AsusWmiWorker(env, deferred, L"DSTS", deviceId, false, false, 0, {});
    worker->Queue();
    return deferred.Promise();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("devsWrite", Napi::Function::New(env, DevsWrite));
    exports.Set("devsWriteBytes", Napi::Function::New(env, DevsWriteBytes));
    exports.Set("dstsRead", Napi::Function::New(env, DstsRead));
    return exports;
}

} // namespace

NODE_API_MODULE(asus_wmi_addon, Init)
