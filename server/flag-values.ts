/** The values of the flag `name` (`--name value` or `--name=value`) in `args`, in order; nothing after `--` counts. */
export function flagValues(args: readonly string[], name: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		if (arg === name) {
			if (i + 1 < args.length) values.push(args[++i]);
		} else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
	}
	return values;
}
