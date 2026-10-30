/**
 * Strings for dropping, pasting and picking files in the message box (#617): the choice between attaching a file and
 * inserting its path, what is refused and why, the upload's progress, and the settings card. They are a lazy namespace: the
 * flow is a chunk of its own (`components/DropChoice.tsx`), fetched when files are first given to the composer, and the
 * strings travel with it (`lib/drop-strings.ts`).
 */
export const en = {
	titleOne: "Add “{name}”",
	titleMany: "Add {n} items",
	progressTitle: "Adding files",
	attach: "Attach",
	attachSome: "Attach {n} of {m}",
	insertPath: "Insert path",
	insertPaths: "Insert paths",
	remember: "Remember for {types}",
	moreItems: "and {n} more",
	hintLocal:
		"Attach puts text, images and the text of PDF and Word documents into the message. Insert path writes where the file is on this Mac.",
	hintUpload:
		"Attach puts text, images and the text of PDF and Word documents into the message. Insert path first sends a copy to the conversation's folder (.omp-webui/uploads), then writes where it is.",

	kindText: "text files",
	kindImage: "images",
	kindDocument: "PDF and Word documents",
	kindOther: "other files",
	kindFolder: "folders",
	labelText: "text",
	labelImage: "image",
	labelDocument: "document",
	labelOther: "file",
	labelFolder: "folder",

	whyFolder: "A folder can't be attached. Insert its path instead.",
	whyFolderNoPath:
		"A folder can't be attached, and only the app on this Mac can tell where one is. Drop the files in it, or type @.",
	whyDocument:
		"Only PDF and Word (.docx) documents can be attached. omp reads this kind of document (an old .doc, Excel, PowerPoint…) from a path.",
	whyDocumentTooLarge: "Over the {limit} a document can be to be read. Insert its path: omp reads what it needs.",
	whyBinary:
		"Only UTF-8 text, images and PDF or Word (.docx) documents can be attached; omp opens other files from a path.",
	whyTooLarge: "Over the {limit} that can go into a message. Insert its path: omp reads what it needs.",
	notAttached: "Not attached: “{name}”. {why}",
	notAttachedTotal: "Not attached: “{name}” would bring this message's text files to {total}; the limit is {limit}.",

	waiting: "Waiting",
	sending: "Sending",
	sent: "Sent",
	failed: "Failed",
	cancelUpload: "Cancel",

	errTooLarge: "“{name}” is larger than the {limit} one file can be when sent to the conversation's folder.",
	errQuota: "The folder of uploads (.omp-webui/uploads) is full ({limit}): free some space there, then try again.",
	errTooManyFiles:
		"The folder of uploads (.omp-webui/uploads) holds {limit} entries already: remove some there, then try again.",
	errOwnData:
		"Nothing can be sent to this conversation's folder: it is where the app keeps its own data. Work in another folder to send files.",
	errFolderGone: "The conversation's folder is not there any more.",
	errUnknown: "The server does not know this conversation.",
	errOff: "Sending files to this computer is switched off on it (Settings › Remote access › File transfer).",
	errRefused: "Not used: .omp-webui/uploads in the conversation's folder is a link or not a folder.",
	errStalled: "The file stopped arriving, so it was not saved",
	errWrite: "The server could not write “{name}” into the conversation's folder.",
	errBadRequest: "The server refused “{name}”.",
	errNoConversation:
		"The conversation has not started yet, so there is nowhere to send “{name}”. Try again in a moment.",
	errFolderNoPath:
		"“{name}” is a folder: only the app on this Mac can tell where a folder is. Drop the files in it, or type @ to pick one.",
	errTooMany: "Only the first {n} files of a drop are taken.",
	errFailed: "“{name}” could not be sent: {error}",
	errRead: "“{name}” could not be read: {error}",

	reading: "Reading “{name}”…",
	docTooLarge: "“{name}” is too large to read: documents over {limit} are not attached. Insert its path instead.",
	docEncrypted: "“{name}” is password-protected, so it can't be read. Remove the password and try again.",
	docDamaged: "“{name}” could not be read: it is damaged, or it is not a PDF or a Word (.docx) file.",
	docOldWord:
		"“{name}” is an old Word file or an encrypted one, and only .docx can be read. Save it as .docx and try again.",
	docEmpty: "Nothing was attached from “{name}”: no text could be read from it.",
	docLeftOut:
		"“{name}” is long: {taken} of {pages} pages were attached, and the rest was left out (limits: {pageLimit} pages and {size} of text).",
	docNoImages: "“{name}”: {n} more pages without text were not sent as images (at most {limit} are).",
	docTextCut: "“{name}” is long: its text was cut at {size}, and the rest was left out.",
	docNotePage: "1 page",
	docNotePages: "{n} pages",
	docNotePagesSome: "{n} of {total} pages",
	docNoteImages: "images: {n}",
	docNoteWord: "Word document",
	docNoteWordCut: "Word document, cut short",
	uploadsCancelled: "The files still being sent were not sent: a new drop took their place.",
	warnMentions:
		"Contains @ mentions: omp reads the files an @path in the message names, including ones in attached text.",

	settingsTitle: "Dropped files",
	settingsIntro:
		"What happens to files you drop, paste or pick in the message box. With “Ask each time” a small choice appears, where it can be remembered for that kind of file.",
	settingsKindText: "Text files",
	settingsKindImage: "Images",
	settingsKindDocument: "PDF and Word (.docx) documents",
	settingsKindOther: "Other files (older Word, Excel, archives…)",
	settingsKindFolder: "Folders",
	choiceAsk: "Ask each time",
	choiceAttach: "Attach",
	choicePath: "Insert path",
	settingsNote:
		"Attached text goes into the message itself, up to {file} per file and {total} per message. A PDF or a Word (.docx) document goes in as the text read from it, and the pages of a PDF that have no text (a scan) go in as images. omp reads other Office documents from a path, so those (and folders) can only be inserted as one. A page that is not the app on this Mac sends a copy into .omp-webui/uploads in the conversation's folder first. The app and a browser keep their own choices, because only the app can insert a real path.",
} as const;
