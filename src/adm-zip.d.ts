declare module "adm-zip" {
  interface ZipEntry { entryName: string; getData(): Buffer }
  export default class AdmZip {
    constructor(path?: string);
    addFile(entryName: string, content: Buffer): void;
    writeZip(fileName: string): void;
    getEntries(): ZipEntry[];
    getEntry(name: string): ZipEntry | null;
    extractAllTo(targetPath: string, overwrite?: boolean): void;
  }
}
