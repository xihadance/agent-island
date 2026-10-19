export function isCodexProfile(value: string): boolean {
  return value.length > 0 && value.length <= 120 && /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(value)
}
