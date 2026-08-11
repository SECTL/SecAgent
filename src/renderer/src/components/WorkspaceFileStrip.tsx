import { extractWorkspaceFiles, type WorkspaceFileReference } from "../../../workspace-file-contract.js";

export function WorkspaceFileStrip({ content }: { content: string }) {
  const files = extractWorkspaceFiles(content);
  if (!files.length) return null;
  const open = (file: WorkspaceFileReference) => { void window.secagent.previewWorkspaceFile(file.path).catch((error: unknown) => window.alert(error instanceof Error ? error.message : String(error))); };
  return <div className="workspace-file-strip" aria-label="工作区文件预览">
    {files.map((file) => <div className="workspace-file-row" key={file.path}><span className="workspace-file-name" title={file.path}>{file.name}</span><button type="button" onClick={() => open(file)}>预览</button></div>)}
  </div>;
}
