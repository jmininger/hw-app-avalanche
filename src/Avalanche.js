//@flow

import type Transport from "@ledgerhq/hw-transport";
import BIPPath from "bip32-path";

/**
 * Avalanche API
 *
 * @example
 * import Avalanche from "@ledgerhq/hw-app-avalanche";
 * const avalanche = new Avalanche(transport);
 */
export default class Avalanche {
  transport: Transport<*>;

  MAX_APDU_SIZE = 230;

  INS_VERSION = 0x00;
  INS_GET_WALLET_ID = 0x01;
  INS_PROMPT_PUBLIC_KEY = 0x02;
  INS_PROMPT_EXT_PUBLIC_KEY = 0x03;
  INS_SIGN_HASH = 0x04;

  constructor(transport: Transport<*>, scrambleKey: string = "Avalanche") {
    this.transport = transport;
    transport.decorateAppAPIMethods(
      this,
      [
        "getAppConfiguration",
        "getWalletId",
        "getWalletPublicKey",
        "signTransaction"
      ],
      scrambleKey
    );
  }

  /**
   * get Avalanche address for a given BIP-32 path.
   *
   * @param derivation_path a path in BIP 32 format
   * @return a buffer with a public key, and TODO: should be address, not public key
   * @example
   * await avalanche.getWalletPublicKey("44'/9000'/0'/0/0");
   */
  async getWalletPublicKey(derivation_path: string): Promise<Buffer> {
    const bipPath = BIPPath.fromString(derivation_path).toPathArray();

    const cla = 0x80;
    const ins = this.INS_PROMPT_PUBLIC_KEY;
    const p1 = 0x00;
    const p2 = 0x00;
    const data = Buffer.alloc(1 + bipPath.length * 4);

    data.writeUInt8(bipPath.length, 0);
    bipPath.forEach((segment, index) => {
      data.writeUInt32BE(segment, 1 + index * 4);
    });

    const response = await this.transport.send(cla, ins, p1, p2, data);
    const publicKeyLength = response[0];
    return response.slice(1, 1 + publicKeyLength);
  }

  /**
   * get extended public key for a given BIP 32 path.
   *
   * @param derivation_path a path in BIP 32 format
   * @return an object with a buffer for the public key data and a buffer for the chain code
   * @example
   * await avalanche.getWalletExtendedPublicKey("44'/9000'/0'/0/0");
   */
  async getWalletExtendedPublicKey(derivation_path: string): Promise<{
    public_key: Buffer,
    chain_code: Buffer
  }> {
    const bipPath = BIPPath.fromString(derivation_path).toPathArray();

    const cla = 0x80;
    const ins = this.INS_PROMPT_EXT_PUBLIC_KEY;
    const p1 = 0x00;
    const p2 = 0x00;
    const data = Buffer.alloc(1 + bipPath.length * 4);

    data.writeUInt8(bipPath.length, 0);
    bipPath.forEach((segment, index) => {
      data.writeUInt32BE(segment, 1 + index * 4);
    });

    const response = await this.transport.send(cla, ins, p1, p2, data);
    const publicKeyLength = response[0];
    const chainCodeOffset = 2+publicKeyLength;
    const chainCodeLength = response[1 + publicKeyLength];
    return {
      public_key: response.slice(1, 1 + publicKeyLength),
      chain_code: response.slice(chainCodeOffset, chainCodeOffset + chainCodeLength),
    };
  }

  /**
   * Sign a hash with a given BIP-32 path.
   *
   * @param derivation_path a path in BIP-32 format
   * @param hash 32-byte buffer containing hash of a transaction
   * @return a buffer with the signature data
   * @example
   * await avalanche.signHash(
   *   "44'/9000'/0'/0/0",
   *   Buffer.from("0000000000000000000000000000000000000000000000000000000000000000", "hex")
   * );
   */
  async signHash(
    derivation_path: string,
    hash: Buffer,
  ): Promise<{
    hash: Buffer,
    signature: Buffer
  }> {
    const bipPath = BIPPath.fromString(derivation_path).toPathArray();

    let rawPath = Buffer.alloc(1 + bipPath.length * 4);
    rawPath.writeInt8(bipPath.length, 0);
    bipPath.forEach((segment, index) => {
      rawPath.writeUInt32BE(segment, 1 + index * 4);
    });
    await this.transport.send(0x80, this.INS_SIGN_HASH, 0x00, 0x00, rawPath);

    const txFullChunks = Math.floor(hash.length / this.MAX_APDU_SIZE);
    for (let i = 0; i < txFullChunks; i++) {
      const data = hash.slice(i*this.MAX_APDU_SIZE, (i+1)*this.MAX_APDU_SIZE);
      await this.transport.send(0x80, this.INS_SIGN_HASH, 0x01, 0x00, data);
    }

    const lastOffset = Math.floor(hash.length / this.MAX_APDU_SIZE) * this.MAX_APDU_SIZE;
    const lastData = hash.slice(lastOffset, lastOffset+this.MAX_APDU_SIZE);
    const response = await this.transport.send(0x80, this.INS_SIGN_HASH, 0x81, 0x00, lastData);

    const responseHash = response.slice(0, 32);
    if (!responseHash.equals(hash)) {
      throw "Signed hash does not match input hash!";
    }

    return {
      hash: responseHash,
      signature: response.slice(32, -2),
    };
  }

  /**
   * Get the version of the Avalanche app installed on the hardware device
   *
   * @return an object with a version
   * @example
   * console.log(await avalanche.getAppConfiguration());
   *
   * {
   *   "version": "1.0.3",
   *   "commit": "0000000000000000000000000000000000000000",
   *   "name": "Avax"
   * }
   */
  async getAppConfiguration(): Promise<{
    version: string,
    commit: string,
    name: string,
  }> {
    const data: Buffer = await this.transport.send(0x80, this.INS_VERSION, 0x00, 0x00);

    const eatNBytes = function(input, n) {
      const out = input.slice(0, n);
      return [out, input.slice(n)];
    };

    const eatWhile = function(input, f) {
      for (var i = 0; i < input.length; i++) {
        if (!f(input[i])) {
          return [input.slice(0, i), input.slice(i)];
        }
      }
      return [input, ""];
    };

    const [versionData, rest1] = eatNBytes(data, 3);
    const [commitData, rest2] = eatWhile(rest1, c => c != 0);
    const [nameData, rest3] = eatWhile(rest2.slice(1), c => c != 0);
    if (rest3.toString("hex") != "009000") {
      console.log("WARNING: Response data does not exactly match expected format for VERSION instruction");
    }

    return {
      version: "" + versionData[0] + "." + versionData[1] + "." + versionData[2],
      commit: commitData.toString("latin1"),
      name: nameData.toString("latin1")
    };
  }

  /**
   * Get the wallet identifier for the Ledger wallet
   *
   * @return a byte string
   * @example
   * console.log((await avalanche.getWalletId()).toString("hex"));
   *
   * 79c46bc3
   */
  async getWalletId(): Promise<Buffer> {
    const result = await this.transport.send(0x80, this.INS_GET_WALLET_ID, 0x00, 0x00);
    return result.slice(0, -2);
  }
}
