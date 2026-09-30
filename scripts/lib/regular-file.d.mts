export function readRegularFile(path: string): Promise<Buffer>;
export function fileIdentity(path: string): Promise<{ bytes: number; sha256: string }>;
