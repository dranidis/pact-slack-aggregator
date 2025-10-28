export function pascalCaseToDash(str: string): string {
	return str
		.replace(/([A-Z])/g, (g) => `-${g[0].toLowerCase()}`) // Add dash before uppercase letters
		.replace(/^-/, '');                                   // Remove leading dash if present
}
