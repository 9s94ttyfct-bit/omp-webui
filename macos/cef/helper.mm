// CEF's helper processes (renderer, GPU, network…) run as the app's "omp-webui Helper" bundles, CEF's standard helper:
// each enters Chrome's macOS sandbox first (the framework's Libraries/libcef_sandbox.dylib), then loads the framework the
// app ships in Contents/Frameworks, as the sandbox's profile lets it read only the app's own bundle.
#include "include/cef_app.h"
#include "include/cef_sandbox_mac.h"
#include "include/wrapper/cef_library_loader.h"

int main(int argc, char* argv[]) {
  CefScopedSandboxContext sandbox;
  if (!sandbox.Initialize(argc, argv)) return 10;
  CefScopedLibraryLoader library;
  if (!library.LoadInHelper()) return 11;
  CefMainArgs args(argc, argv);
  return CefExecuteProcess(args, nullptr, nullptr);
}
