import { readFile } from 'node:fs/promises';
import { runInThisContext } from 'node:vm';
import path from 'node:path';
import { config } from '../config';

// Loads Lighter's official Go signer (lighter-go, compiled to WebAssembly) shipped in the app repo at
// vendor/lighter. All HTTP happens in JS; the signer only produces signed tx bytes.

export type SignOut = { txType?: number; txInfo?: string; txHash?: string; messageToSign?: string; error?: string };
export interface Signer {
  CreateClient(url: string, pk: string, chainId: number, apiKeyIndex: number, accountIndex: number): { error?: string };
  SignCreateOrder(...a: number[]): SignOut;
  SignTransfer(to: number, asset: number, fromRoute: number, toRoute: number, amount: number, usdcFee: number, memo: string, skipNonce: number, nonce: number, keyIdx: number, acct: number): SignOut;
  SignWithdraw(asset: number, route: number, amount: number, skipNonce: number, nonce: number, keyIdx: number, acct: number): SignOut;
  CreateAuthToken(deadline: number, keyIdx: number, acct: number): { authToken?: string; error?: string };
}

let p: Promise<Signer> | null = null;
export function loadSigner(): Promise<Signer> {
  p ??= (async () => {
    const dir = path.resolve(config().LIGHTER_WASM_DIR);
    const shim = path.join(dir, 'wasm_exec.js');
    runInThisContext(await readFile(shim, 'utf8'), { filename: shim });
    const g = globalThis as unknown as { Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> } };
    const go = new g.Go();
    const mod = await WebAssembly.compile(new Uint8Array(await readFile(path.join(dir, 'lighter-signer.wasm'))));
    const instance = await WebAssembly.instantiate(mod, go.importObject);
    void go.run(instance).catch(() => { p = null; });
    const s = globalThis as unknown as Signer;
    if (typeof s.CreateClient !== 'function') throw new Error('Lighter signer did not register');
    return s;
  })();
  p.catch(() => { p = null; });
  return p;
}
