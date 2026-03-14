declare module "jszip" {
	interface JSZipObject {
		dir: boolean;
		async(type: "string"): Promise<string>;
	}
	interface JSZipInstance {
		files: Record<string, JSZipObject>;
	}
	interface JSZipStatic {
		loadAsync(data: ArrayBuffer): Promise<JSZipInstance>;
	}
	const JSZip: JSZipStatic;
	export = JSZip;
}
