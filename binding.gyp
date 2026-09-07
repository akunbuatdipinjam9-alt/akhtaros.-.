{
  "targets": [
    {
      "target_name": "asus_wmi_addon",
      "sources": [ "addon.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS=0", "UNICODE", "_UNICODE" ],
      "conditions": [
        [ "OS=='win'", {
          "libraries": [ "wbemuuid.lib", "ole32.lib", "oleaut32.lib" ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": [ "/std:c++17" ]
            }
          }
        }, {
          "sources": []
        } ]
      ]
    }
  ]
}