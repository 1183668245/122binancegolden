function pad3(n) {
  const s = String(n);
  return s.length >= 3 ? s : "0".repeat(3 - s.length) + s;
}

export function createHistoryService({ vault }) {
  async function getDrawHistory({ limit = 100 } = {}) {
    const currentRoundId = await vault.currentRoundId();
    const start = currentRoundId > 0n ? currentRoundId - 1n : 0n;
    const count = Number(limit);

    const ids = [];
    for (let i = 0; i < count; i++) {
      const id = start - BigInt(i);
      if (id < 0n) break;
      ids.push(id);
    }

    const rounds = await Promise.all(
      ids.map(async (id) => {
        const r = await vault.rounds(id);
        return {
          roundId: id.toString(),
          startTime: Number(r.startTime),
          endTime: Number(r.endTime),
          resolved: Boolean(r.resolved),
          winningNumber: pad3(Number(r.winningNumber)),
        };
      })
    );

    const resolvedRounds = rounds.filter((r) => r.resolved);
    return { currentRoundId: currentRoundId.toString(), items: resolvedRounds };
  }

  return { getDrawHistory };
}

