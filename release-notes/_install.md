
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

## 安装 macOS 应用

1. 下载 `omp-webui-vX.Y.Z.dmg`（Apple 芯片）并打开。
2. 把窗口里的 **omp-webui** 拖到 **Applications（应用程序）** 文件夹，然后推出磁盘映像。
3. 应用用自签名证书签名、没有经过 Apple 公证，所以 macOS 会给下载的文件加上“隔离”标记并拒绝打开。在终端运行一次：

   ```sh
   xattr -dr com.apple.quarantine /Applications/omp-webui.app
   ```

   或者先打开一次，再到“系统设置 › 隐私与安全性”里点“仍要打开”。
4. 打开 omp-webui。如果还没有安装 [`omp`](https://omp.sh)，应用会提供安装，并引导你完成首次设置。
