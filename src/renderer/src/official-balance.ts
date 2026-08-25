export function formatOfficialPoints(points: number): string {
  return points.toFixed(2);
}

export function formatOfficialBalanceExpiry(expiresAt: string | null): string {
  return expiresAt ? `失效：${new Date(expiresAt).toLocaleString("zh-CN", { hour12: false })}` : "永久额度";
}
