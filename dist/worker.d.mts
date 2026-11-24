import type { OrcaWorkerApi } from 'orca/worker'

export default function activate(orca: OrcaWorkerApi): void
export function deactivate(): Promise<void>
