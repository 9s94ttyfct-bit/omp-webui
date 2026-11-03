#!/bin/sh
# Installs omp-webui for the current user: the Linux package's install.sh (scripts/linux-package.ts copies it in), run
# from the unpacked folder that holds it, the program `omp-webui` and `web/`.
#
# - The folder is copied to ${XDG_DATA_HOME:-~/.local/share}/omp-webui: next to it first, then swapped in for the copy
#   an earlier install left there, so a copy that is cut short replaces nothing.
# - ~/.local/bin/omp-webui starts it, with the arguments it is given.
# - An entry in the applications menu starts it in a terminal: that window is the server's console, as the Windows
#   launcher's is, and closing it stops the server.
#
# Installing a newer package the same way updates it. `./install.sh --uninstall` removes all of that again. Neither
# touches the server's data folder (~/.omp-webui, or OMP_WEBUI_DATA_DIR): what omp-webui keeps there is kept.
set -eu

usage() {
	echo "usage: ./install.sh [--uninstall]" >&2
	exit 2
}

uninstall=0
case $# in
0) ;;
1) [ "$1" = --uninstall ] || usage; uninstall=1 ;;
*) usage ;;
esac

data_home=${XDG_DATA_HOME:-$HOME/.local/share}
dest=$data_home/omp-webui
bin_dir=$HOME/.local/bin
wrapper=$bin_dir/omp-webui
icon=$data_home/icons/hicolor/256x256/apps/omp-webui.png
apps=$data_home/applications
entry=$apps/omp-webui.desktop

# The menu reads its entries again when told to; a desktop without the tool reads the folder by itself.
refresh_menu() {
	if command -v update-desktop-database >/dev/null 2>&1; then
		update-desktop-database "$apps" >/dev/null 2>&1 || true
	fi
}

if [ "$uninstall" = 1 ]; then
	rm -rf "$dest"
	rm -f "$wrapper" "$icon" "$entry"
	refresh_menu
	echo "omp-webui is uninstalled. Its data folder (~/.omp-webui, or OMP_WEBUI_DATA_DIR) is kept: delete it yourself to remove your data too."
	exit 0
fi

here=$(cd "$(dirname "$0")" && pwd -P)
if [ ! -f "$here/omp-webui" ] || [ ! -d "$here/web" ]; then
	echo "install.sh: run it from the unpacked omp-webui-linux folder: omp-webui and web/ must be beside it" >&2
	exit 1
fi

# The paths go into the command and the menu entry inside double quotes, where these characters would mean something.
case $dest in
*[\"\`\$\\%]* | *"
"*)
	echo "install.sh: cannot install into $dest: its path holds a quote, a backtick, \$, \\, % or a line break" >&2
	exit 1
	;;
esac

mkdir -p "$data_home"
current=
[ -d "$dest" ] && current=$(cd "$dest" && pwd -P)
if [ "$here" = "$current" ]; then
	# Run again from the installed copy: the program is in place already, only the command and the menu entry are written.
	:
else
	next=$dest.installing.$$
	previous=$dest.previous.$$
	trap 'rm -rf "$next"' EXIT
	rm -rf "$next"
	mkdir "$next"
	cp -p "$here/omp-webui" "$next/"
	cp -p "$0" "$next/install.sh"
	cp -Rp "$here/web" "$next/web"
	[ -f "$here/omp-webui.png" ] && cp -p "$here/omp-webui.png" "$next/"
	chmod 755 "$next" "$next/omp-webui" "$next/install.sh"
	if [ -e "$dest" ]; then
		mv "$dest" "$previous"
		mv "$next" "$dest" || {
			mv "$previous" "$dest"
			exit 1
		}
		rm -rf "$previous"
	else
		mv "$next" "$dest"
	fi
fi

mkdir -p "$bin_dir"
cat >"$wrapper.$$" <<EOF
#!/bin/sh
# Written by omp-webui's install.sh: starts the installed omp-webui.
exec "$dest/omp-webui" "\$@"
EOF
chmod 755 "$wrapper.$$"
mv "$wrapper.$$" "$wrapper"

icon_line=
if [ -f "$dest/omp-webui.png" ]; then
	mkdir -p "$(dirname "$icon")"
	cp "$dest/omp-webui.png" "$icon"
	icon_line="Icon=$icon"
fi

mkdir -p "$apps"
{
	echo "[Desktop Entry]"
	echo "Type=Application"
	echo "Name=omp-webui"
	echo "Comment=A web UI for the omp coding agent"
	echo "Exec=\"$dest/omp-webui\""
	[ -z "$icon_line" ] || echo "$icon_line"
	echo "Terminal=true"
	echo "Categories=Development;"
} >"$entry.$$"
mv "$entry.$$" "$entry"
refresh_menu

echo "omp-webui is installed in $dest."
echo "Start it from the applications menu, or run: omp-webui"
echo "Its data folder (~/.omp-webui, or OMP_WEBUI_DATA_DIR) is kept by updates and by ./install.sh --uninstall."
case ":$PATH:" in
*":$bin_dir:"*) ;;
*) echo "Note: $bin_dir is not on your PATH: add it to run omp-webui by name, or run $wrapper." ;;
esac
