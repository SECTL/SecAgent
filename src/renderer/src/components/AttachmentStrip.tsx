
export function AttachmentStrip({ attachments, removable = false, onRemove, onOpen }: { attachments: ChatAttachment[]; removable?: boolean; onRemove?: (id: string) => void; onOpen?: (attachment: ChatAttachment) => void }) {
  if (!attachments.length) return null;
  return <div className={`attachment-strip ${removable ? "composer-attachment-strip" : "message-attachment-strip"}`}>
    {attachments.map((attachment) => <div className="attachment-card" key={attachment.id} title={attachment.name}>
      {onOpen ? <button type="button" className="attachment-preview-button" aria-label={`预览 ${attachment.name}`} onClick={() => onOpen(attachment)}><img src={attachment.dataUrl} alt={attachment.name} /></button> : <img src={attachment.dataUrl} alt={attachment.name} />}
      {removable && <button type="button" className="attachment-remove" aria-label={`移除 ${attachment.name}`} onClick={() => onRemove?.(attachment.id)}>×</button>}
    </div>)}
  </div>;
}
