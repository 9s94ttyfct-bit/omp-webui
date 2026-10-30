#!/bin/sh
# omp-webui update helper (#571). The server writes this file into <data dir>/update/ and starts it, detached, just
# before it asks the app to quit: it runs from there and never from inside the app it replaces.
#
#   helper.sh <id> <app-pid> <installed> <staged> <backup> <state-dir> <quit-secs> <start-secs> <from> <to> -- <relaunch…>
#
# It waits for the app to quit, looks once more at the staged copy, swaps it in by rename (the old app stays as <backup>),
# starts the new app (<relaunch…> is the command that does) and waits for the new server to say it is up
# (<state-dir>/ack.json with this id). Anything that fails puts the old app back and starts it again; the reason is written
# to <state-dir>/result.json for the next server to show. After a start that worked the backup is removed and nothing is
# written: the new server writes the success itself when it says it is up.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

id=$1
app_pid=$2
installed=$3
staged=$4
backup=$5
state=$6
quit_secs=$7
start_secs=$8
from=$9
shift 9
to=$1
shift
[ "$1" = "--" ] && shift
# What is left in "$@" starts the app.

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*"; }

# Write how this ended, for the next server (atomically: it may look at once).
fail() {
	tmp="$state/result.json.$$"
	printf '{"id":"%s","ok":false,"from":"%s","to":"%s","at":%s000,"problem":"%s"}\n' \
		"$id" "$from" "$to" "$(date +%s)" "$1" >"$tmp" && mv "$tmp" "$state/result.json"
	log "failed: $1"
}

# A bundle's designated requirement and plist keys, as the server checked them.
requirement() { codesign -d -r- "$1" 2>/dev/null | grep '^designated =>'; }
plist() { plutil -extract "$2" raw -o - "$1/Contents/Info.plist" 2>/dev/null; }

log "waiting for pid $app_pid to quit (up to $quit_secs s)"
n=0
while kill -0 "$app_pid" 2>/dev/null; do
	n=$((n + 1))
	if [ "$n" -gt $((quit_secs * 5)) ]; then
		fail quitTimeout
		rm -rf "$staged"
		rm -f "$state/handover.json"
		exit 1
	fi
	sleep 0.2
done
log "the app has quit"

# The last look: the staged copy is what the server checked, and still is, and is signed as the app that is installed is.
bad=
codesign --verify --deep --strict "$staged" || bad="signature"
[ "$(plist "$staged" CFBundleShortVersionString)" = "$to" ] || bad="${bad:+$bad, }version"
[ "$(plist "$staged" CFBundleIdentifier)" = "$(plist "$installed" CFBundleIdentifier)" ] || bad="${bad:+$bad, }identifier"
old_requirement=$(requirement "$installed")
new_requirement=$(requirement "$staged")
case "$new_requirement" in
*'certificate leaf = H"'*) ;;
*) bad="${bad:+$bad, }requirement" ;;
esac
[ -n "$old_requirement" ] && [ "$old_requirement" = "$new_requirement" ] || bad="${bad:+$bad, }requirement"
if [ -n "$bad" ]; then
	log "the staged app is not fit to install ($bad)"
	fail verify
	rm -rf "$staged"
	rm -f "$state/handover.json"
	"$@"
	exit 1
fi

# The swap: two renames in one folder, so neither copies anything. The old app is the backup until the new one is up.
rm -rf "$backup"
if ! mv "$installed" "$backup"; then
	fail swap
	rm -rf "$staged"
	rm -f "$state/handover.json"
	"$@"
	exit 1
fi
if ! mv "$staged" "$installed"; then
	if mv "$backup" "$installed"; then fail swap; else fail rollbackFailed; fi
	rm -f "$state/handover.json"
	"$@"
	exit 1
fi
xattr -dr com.apple.quarantine "$installed" 2>/dev/null
log "swapped; the old app is $backup"

rm -f "$state/ack.json"
problem=didNotStart
if "$@"; then
	n=0
	while [ "$n" -lt $((start_secs * 2)) ]; do
		if [ -f "$state/ack.json" ] && grep -q "\"id\":\"$id\"" "$state/ack.json"; then
			rm -rf "$backup"
			rm -f "$state/ack.json" "$state/handover.json"
			log "the new app is up; the backup is removed"
			exit 0
		fi
		sleep 0.5
		n=$((n + 1))
	done
else
	problem=swap
fi

# It did not start: whatever of it runs is ended (the app only: a server of the old app's conversations is none of ours),
# and the old app is put back and started.
log "the new app did not start ($problem): putting the old one back"
ps -A -o pid=,command= | while read -r p cmd; do
	case "$cmd" in
	"$installed/Contents/MacOS/"*) kill "$p" 2>/dev/null ;;
	esac
done
sleep 2
ps -A -o pid=,command= | while read -r p cmd; do
	case "$cmd" in
	"$installed/Contents/MacOS/"*) kill -9 "$p" 2>/dev/null ;;
	esac
done
# The new app is moved aside, not removed, until the old one is back in its place: whatever fails, there is an app at the
# installed path (a rollback that removed the new one first and then could not rename the backup left none at all).
aside="$installed.failed"
rm -rf "$aside"
if mv "$installed" "$aside"; then
	if mv "$backup" "$installed"; then
		rm -rf "$aside"
		fail "$problem"
	else
		mv "$aside" "$installed"
		fail rollbackFailed
		rm -f "$state/handover.json"
		exit 1
	fi
else
	fail rollbackFailed
	rm -f "$state/handover.json"
	exit 1
fi
rm -f "$state/ack.json" "$state/handover.json"
"$@"
exit 1
