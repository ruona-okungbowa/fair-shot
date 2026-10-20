// Fetches a named drand quicknet round and verifies its BLS signature before trusting it.
import { fetchBeacon, HttpCachingChain, HttpChainClient } from "drand-client";
import { QUICKNET } from "./draw.ts";

const options = {
  disableBeaconVerification: false,
  noCache: false,
  chainVerificationParams: { chainHash: QUICKNET.chainHash, publicKey: QUICKNET.publicKey },
};

export async function quicknetRandomness(round: number): Promise<string> {
  const chain = new HttpCachingChain(`https://api.drand.sh/${QUICKNET.chainHash}`, options);
  const beacon = await fetchBeacon(new HttpChainClient(chain, options), round);
  if (beacon.round !== round) throw new Error(`asked for round ${round}, got ${beacon.round}`);
  return beacon.randomness;
}
