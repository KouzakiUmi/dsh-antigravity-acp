export interface Usage {
  balanceCu: number | null
  rateCuPerHour: number | null
  activeAssignments: number | null
}

function pick(text: string, pattern: RegExp, integer = false): number | null {
  const matches = text.split(/\r?\n/).flatMap((line) => {
    const value = pattern.exec(line)?.[1]
    return value === undefined ? [] : [Number(value)]
  })
  const value = matches[0]
  if (matches.length !== 1 || value === undefined || !Number.isFinite(value) ||
      (integer && !Number.isSafeInteger(value))) return null
  // Python rounds small negative values to "-0.00"; DSH's lossless JSON rejects -0.
  return value === 0 ? 0 : value
}

/** Colab CLI v0.8.0 renders three independent labeled lines. */
export function parseUsage(text: string): Usage {
  return {
    balanceCu: pick(text, /^Current balance: (-?\d+(?:\.\d+)?) compute units\s*$/),
    rateCuPerHour: pick(text, /^Usage rate: (-?\d+(?:\.\d+)?)\/hr\s*$/),
    activeAssignments: pick(text, /^Active assignments: (\d+)\s*$/, true),
  }
}
