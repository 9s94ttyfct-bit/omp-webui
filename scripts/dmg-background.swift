// Draws the background of the installer disk image (scripts/dmg.ts): a 660 × 400 pt window with the app
// on the left, the Applications link on the right and an arrow between them. Written as a multi-resolution
// TIFF (1x and 2x), the form Finder wants for a background that stays sharp on Retina screens.
//
//   swiftc -O dmg-background.swift -o dmg-background && ./dmg-background background.tiff
//
// The mid-tone blue-grey is deliberate: Finder draws icon labels in black in the light appearance and in
// white in the dark one, and both have to stay readable on the same picture.
import AppKit

let width = 660.0
let height = 400.0
// Icon centres, in Finder's coordinates (origin top-left); scripts/dmg.ts positions the icons there.
let appX = 165.0
let appsX = 495.0
let iconY = 190.0

func render(scale: Int) -> NSBitmapImageRep {
	let rep = NSBitmapImageRep(
		bitmapDataPlanes: nil, pixelsWide: Int(width) * scale, pixelsHigh: Int(height) * scale,
		bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
		colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
	rep.size = NSSize(width: width, height: height)
	NSGraphicsContext.saveGraphicsState()
	NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
	defer { NSGraphicsContext.restoreGraphicsState() }

	NSGradient(
		starting: NSColor(srgbRed: 0.50, green: 0.56, blue: 0.68, alpha: 1),
		ending: NSColor(srgbRed: 0.36, green: 0.42, blue: 0.56, alpha: 1)
	)!.draw(in: NSRect(x: 0, y: 0, width: width, height: height), angle: -90)

	// Arrow between the two icons (drawing origin is bottom-left).
	let y = height - iconY
	let arrow = NSBezierPath()
	arrow.lineWidth = 7
	arrow.lineCapStyle = .round
	arrow.lineJoinStyle = .round
	arrow.move(to: NSPoint(x: appX + 90, y: y))
	arrow.line(to: NSPoint(x: appsX - 90, y: y))
	arrow.move(to: NSPoint(x: appsX - 112, y: y + 22))
	arrow.line(to: NSPoint(x: appsX - 90, y: y))
	arrow.line(to: NSPoint(x: appsX - 112, y: y - 22))
	NSColor(white: 1, alpha: 0.85).setStroke()
	arrow.stroke()

	func caption(_ text: String, size: CGFloat, weight: NSFont.Weight, alpha: CGFloat, centreY: CGFloat) {
		let style = NSMutableParagraphStyle()
		style.alignment = .center
		let string = NSAttributedString(
			string: text,
			attributes: [
				.font: NSFont.systemFont(ofSize: size, weight: weight),
				.foregroundColor: NSColor(white: 1, alpha: alpha),
				.paragraphStyle: style,
			])
		let box = string.boundingRect(
			with: NSSize(width: width - 80, height: 200), options: [.usesLineFragmentOrigin])
		string.draw(
			with: NSRect(x: 40, y: centreY - box.height / 2, width: width - 80, height: box.height),
			options: [.usesLineFragmentOrigin])
	}
	caption("Drag omp-webui to Applications  ·  拖到“应用程序”安装", size: 17, weight: .semibold, alpha: 0.95, centreY: 70)
	caption(
		"Not notarized: if macOS refuses to open it, see the install steps in the release notes.\n未经公证：如果 macOS 拒绝打开，请看发布说明里的安装步骤。",
		size: 11, weight: .regular, alpha: 0.8, centreY: 32)
	return rep
}

guard CommandLine.arguments.count == 2 else {
	FileHandle.standardError.write("usage: dmg-background <out.tiff>\n".data(using: .utf8)!)
	exit(2)
}
let image = NSImage(size: NSSize(width: width, height: height))
image.addRepresentation(render(scale: 1))
image.addRepresentation(render(scale: 2))
guard let tiff = image.tiffRepresentation else { exit(1) }
try tiff.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
