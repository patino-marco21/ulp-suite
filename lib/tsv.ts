/** ClickHouse's TabSeparated escapes: `\t \n \r \0 \b \f \' \\`. */
const TSV_ESCAPES: Record<string, string> = { t: '\t', n: '\n', r: '\r', '0': '\0', b: '\b', f: '\f', "'": "'", '\\': '\\' }

/** One TSV field as the string it was before ClickHouse escaped it. */
export function unescapeTsv(field: string): string {
  return field.replace(/\\([tnr0bf'\\])/g, (_, c: string) => TSV_ESCAPES[c])
}
