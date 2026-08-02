declare module "adm-zip" {
  interface ZipEntry { entryName: string; getData(): Buffer }
  export default class AdmZip {
    constructor(path?: string);
    getEntries(): ZipEntry[];
    getEntry(name: string): ZipEntry | null;
    extractAllTo(targetPath: string, overwrite?: boolean): void;
  }
}
