const QUOTE_MARKER = "引用内容：\n";

export function buildQuotedUserMessage(quote: string, body: string): string {
  const quoted = quote.trim();
  const text = body.replace(/\u200b/g, "").trim();
  if (!quoted) return text;
  return text ? `${QUOTE_MARKER}${quoted}\n\n${text}` : `${QUOTE_MARKER}${quoted}`;
}

export function parseQuotedUserMessage(content: string): { quote?: string; body: string } {
  if (!content.startsWith(QUOTE_MARKER)) return { body: content };
  const rest = content.slice(QUOTE_MARKER.length);
  const split = rest.indexOf("\n\n");
  if (split < 0) return { quote: rest, body: "" };
  return { quote: rest.slice(0, split), body: rest.slice(split + 2) };
}

export function webSearchUrl(query: string): string {
  return `https://cn.bing.com/search?q=${encodeURIComponent(query.trim())}`;
}
