
---

## Install the macOS app

1. Download `omp-webui-vX.Y.Z.dmg` (Apple Silicon) and open it.
2. Drag **omp-webui** onto the **Applications** folder in the window, then eject the disk image.
3. The app is signed with a self-signed certificate, not notarized, so macOS quarantines the download and refuses to open it. Run this once in Terminal:

   ```sh
   xattr -dr com.apple.quarantine /Applications/omp-webui.app
   ```

   Or open the app once, then choose **Open Anyway** in System Settings › Privacy & Security.
4. Open omp-webui. If [`omp`](https://omp.sh) isn't installed yet, the app offers to install it and walks you through the first setup.

## Run omp-webui on Windows

1. Download `omp-webui-vX.Y.Z-windows-x64.zip` (Windows 10 or later, x64) and extract it anywhere. Keep the `web` folder beside `omp-webui.exe`.
2. Double-click `omp-webui.exe`. It is not signed, so SmartScreen may warn the first time: choose **More info › Run anyway**.
3. It opens omp-webui in your default browser. Its console window stays open while it runs; close it to stop omp-webui. If [`omp`](https://omp.sh) isn't installed yet, the page offers to install it.
4. From 0.17.0 it updates itself (Settings › Updates). Coming from 0.16.0, update by hand once: download the new zip and replace the folder. Keep the folder somewhere you can write to (not under Program Files), or the update cannot replace it.

## 安装 macOS 应用

1. 下载 `omp-webui-vX.Y.Z.dmg`（Apple 芯片）并打开。
2. 把窗口里的 **omp-webui** 拖到 **Applications（应用程序）** 文件夹，然后推出磁盘映像。
3. 应用用自签名证书签名、没有经过 Apple 公证，所以 macOS 会给下载的文件加上“隔离”标记并拒绝打开。在终端运行一次：

   ```sh
   xattr -dr com.apple.quarantine /Applications/omp-webui.app
   ```

   或者先打开一次，再到“系统设置 › 隐私与安全性”里点“仍要打开”。
4. 打开 omp-webui。如果还没有安装 [`omp`](https://omp.sh)，应用会提供安装，并引导你完成首次设置。

## 在 Windows 上运行 omp-webui

1. 下载 `omp-webui-vX.Y.Z-windows-x64.zip`（Windows 10 或更高，x64），解压到任意位置。`web` 文件夹要留在 `omp-webui.exe` 旁边。
2. 双击 `omp-webui.exe`。它没有签名，第一次运行时 SmartScreen 可能会警告：点“更多信息 › 仍要运行”。
3. 它会在默认浏览器里打开 omp-webui。运行期间它的控制台窗口一直开着；关掉这个窗口就停止 omp-webui。如果还没有安装 [`omp`](https://omp.sh)，页面会提供安装。
4. 从 0.17.0 起它会自动更新（设置 › 更新）。从 0.16.0 升级需要手动一次：下载新的 zip，替换整个文件夹。文件夹要放在你有写入权限的地方（不要放在 Program Files 下），否则更新无法替换它。
