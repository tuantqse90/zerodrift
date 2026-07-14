// EpochHistory — on-chain hedge attestations from the HedgeRegistry.

import { REGISTRY_ADDRESS, type EpochRow } from "../lib/chain";

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function ago(unixSec: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function EpochHistory({ epochs, loading }: { epochs: EpochRow[]; loading: boolean }) {
  return (
    <div>
      {loading ? (
        <div className="empty">Reading the HedgeRegistry…</div>
      ) : epochs.length === 0 ? (
        <div className="empty">No epochs recorded yet. Open a hedge to write the first one.</div>
      ) : (
        <table className="epoch-table">
          <thead>
            <tr>
              <th>FARMER</th>
              <th>EPOCH</th>
              <th>NOTIONAL</th>
              <th>OPENED</th>
              <th>STATUS</th>
            </tr>
          </thead>
          <tbody>
            {epochs.slice(0, 8).map((e) => (
              <tr key={`${e.owner}-${e.epochId}`}>
                <td>
                  <a href={`https://monadscan.com/address/${e.owner}`} target="_blank" rel="noreferrer">
                    {short(e.owner)}
                  </a>
                </td>
                <td>#{e.epochId}</td>
                <td>${e.notionalUsd.toFixed(2)}</td>
                <td>{ago(e.openedAt)}</td>
                <td>
                  <span className={`chip ${e.closed ? "closed" : "open"}`}>{e.closed ? "CLOSED" : "OPEN"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="reg-foot">
        Registry{" "}
        <a href={`https://monadscan.com/address/${REGISTRY_ADDRESS}`} target="_blank" rel="noreferrer">
          {short(REGISTRY_ADDRESS)}
        </a>{" "}
        · verified source · holds no funds
      </div>
    </div>
  );
}
