export function keyedOptions(options: readonly string[]): Array<{ key: string; option: string }> {
  const occurrences = new Map<string, number>();
  return options.map((option) => {
    const occurrence = occurrences.get(option) ?? 0;
    occurrences.set(option, occurrence + 1);
    return { key: `${option}\u0000${occurrence}`, option };
  });
}
