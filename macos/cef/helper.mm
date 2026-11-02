// CEF's helper processes (renderer, GPU, network…) run as the app's "omp-webui Helper" bundles. The framework is not in the
// app: it is in the data folder, where the server installed it, and the app tells every helper where (`--ompw-framework=`,
// CEFHost.mm's `OnBeforeChildProcessLaunch`).
#include <string>

#include "include/cef_app.h"
#include "include/wrapper/cef_library_loader.h"

int main(int argc, char* argv[]) {
  const std::string key = "--ompw-framework=";
  std::string framework;
  for (int i = 1; i < argc; i++) {
    std::string arg = argv[i];
    if (arg.rfind(key, 0) == 0) framework = arg.substr(key.size());
  }
  if (framework.empty()) return 10;
  std::string lib = framework + "/Chromium Embedded Framework.framework/Chromium Embedded Framework";
  if (!cef_load_library(lib.c_str())) return 11;
  CefMainArgs args(argc, argv);
  int code = CefExecuteProcess(args, nullptr, nullptr);
  cef_unload_library();
  return code;
}
