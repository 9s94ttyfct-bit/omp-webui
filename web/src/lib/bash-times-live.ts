import { noteBashEnded } from "./bash-times.ts";
import { socket } from "./ws.ts";

/**
 * Records how long each `!command` ran, as the server says it ends (`bash_ended`, see `lib/bash-times.ts`). It is a module of
 * the chat's chunk, not of the first page: whoever shows a command's length loads it, and listens from then on, so the first
 * page load carries none of it. A command that ends before the chat was opened in this page has no length here.
 */
socket.on((msg) => {
	if (msg.t === "frame" && msg.frame.type === "bash_ended") noteBashEnded(msg.frame);
});
