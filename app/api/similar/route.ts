import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"

export const dynamic = 'force-dynamic'

interface PasswordRow {
  password: string
  freq: number
  phash: bigint
}

interface PasswordCluster {
  representative: string
  variants: string[]
  total_freq: number
}

/**
 * Count differing bits between two 64-bit unsigned hashes (Hamming distance).
 * Uses BigInt to handle the full UInt64 range returned by ngramSimHash().
 */
function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b
  let dist = 0
  while (xor > BigInt(0)) {
    dist += Number(xor & BigInt(1))
    xor >>= BigInt(1)
  }
  return dist
}

// GET /api/similar?min_freq=2&limit=200
// Returns clusters of near-duplicate passwords using ngramSimHash(password, 3).
// Two passwords are considered "similar" when their Hamming distance <= 5 bits.
export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const minFreq = Math.max(1, parseInt(searchParams.get('min_freq') || '2', 10))
  const limit = Math.min(500, Math.max(50, parseInt(searchParams.get('limit') || '200', 10)))

  try {
    // Fetch top passwords with their SimHash fingerprints.
    // toString() converts UInt64 to a decimal string BigInt can safely parse.
    const rows = await executeQuery(`
      SELECT
        password,
        count() AS freq,
        toString(ngramSimHash(password, 3)) AS phash
      FROM ulp.credentials
      GROUP BY password
      HAVING freq >= {minFreq:UInt32}
      ORDER BY freq DESC
      LIMIT {limit:UInt32}
    `, { minFreq, limit }) as Array<{ password: string; freq: string; phash: string }>

    const parsed: PasswordRow[] = rows.map(r => ({
      password: r.password,
      freq: Number(r.freq),
      phash: BigInt(r.phash),
    }))

    // Greedy single-pass clustering: assign each unassigned password to the
    // first cluster whose representative is within Hamming distance 5.
    const assigned = new Set<number>()
    const clusters: PasswordCluster[] = []

    for (let i = 0; i < parsed.length; i++) {
      if (assigned.has(i)) continue

      const pivot = parsed[i]
      const clusterPasswords: string[] = [pivot.password]
      let totalFreq = pivot.freq
      assigned.add(i)

      for (let j = i + 1; j < parsed.length; j++) {
        if (assigned.has(j)) continue
        if (hammingDistance(pivot.phash, parsed[j].phash) <= 5) {
          clusterPasswords.push(parsed[j].password)
          totalFreq += parsed[j].freq
          assigned.add(j)
        }
      }

      // Only emit clusters with at least 2 members
      if (clusterPasswords.length > 1) {
        clusters.push({
          representative: pivot.password,
          variants: clusterPasswords,
          total_freq: totalFreq,
        })
      }
    }

    // Sort by combined frequency (most impactful clusters first)
    clusters.sort((a, b) => b.total_freq - a.total_freq)

    return NextResponse.json({
      success: true,
      clusters: clusters.slice(0, 50),
      total_clusters: clusters.length,
    })
  } catch (error) {
    console.error('Similar passwords error:', error)
    return NextResponse.json({ success: false, error: 'Query failed' }, { status: 500 })
  }
}
