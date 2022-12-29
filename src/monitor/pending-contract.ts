import { SourcifyEventManager, StringMap } from "@ethereum-sourcify/core";
import SourceFetcher from "./source-fetcher";
import { SourceAddress } from "./util";
import Web3 from "web3";
import { CheckedContract, isEmpty } from "@ethereum-sourcify/core";

type PendingSource = {
  keccak256: string;
  content?: string;
  urls: string[];
  name: string;
};
interface PendingSourceMap {
  [keccak256: string]: PendingSource;
}
type Metadata = { sources: PendingSourceMap };

export default class PendingContract {
  private metadata: Metadata | undefined;
  private pendingSources: PendingSourceMap = {};
  private fetchedSources: StringMap = {};
  private sourceFetcher: SourceFetcher;
  private callback: (contract: CheckedContract) => void;

  constructor(
    sourceFetcher: SourceFetcher,
    callback: (checkedContract: CheckedContract) => void
  ) {
    this.sourceFetcher = sourceFetcher;
    this.callback = callback;
  }

  /**
   * Assembles this contract by first fetching its metadata and then fetching all the sources listed in the metadata.
   *
   * @param metadataAddress an object representing the location of the contract metadata
   */
  assemble(metadataAddress: SourceAddress) {
    this.sourceFetcher.subscribe(metadataAddress, this.addMetadata);
  }

  private addMetadata = (rawMetadata: string) => {
    this.metadata = JSON.parse(rawMetadata) as Metadata;

    for (const name in this.metadata.sources) {
      const source = this.metadata.sources[name];
      source.name = name;

      if (source.content) {
        this.fetchedSources[name] = source.content;
        continue;
      } else if (!source.keccak256) {
        const err =
          "PendingContract.addMetadata: The source provides neither content nor keccak256";
        SourcifyEventManager.trigger("Monitor.Error", {
          message: err,
          details: {
            name,
          },
        });
        break;
      }
      this.pendingSources[source.keccak256] = source;

      const sourceAddresses: SourceAddress[] = [];
      for (const url of source.urls) {
        const sourceAddress = SourceAddress.fromUrl(url);
        if (!sourceAddress) {
          SourcifyEventManager.trigger("Monitor.Error", {
            message:
              "PendingContract.addMetadata: Could not determine source file location",
            details: {
              name,
              url,
            },
          });
          continue;
        }
        sourceAddresses.push(sourceAddress);

        this.sourceFetcher.subscribe(sourceAddress, (sourceContent: string) => {
          this.addFetchedSource(sourceContent);
          // once source is resolved from one endpoint, others don't have to be pinged anymore, so delete them
          for (const deletableSourceAddress of sourceAddresses) {
            this.sourceFetcher.unsubscribe(deletableSourceAddress);
          }
        });
      }
    }

    if (isEmpty(this.pendingSources)) {
      const contract = new CheckedContract(this.metadata, this.fetchedSources);
      this.callback(contract);
    }
  };

  private addFetchedSource = (sourceContent: string) => {
    const hash = Web3.utils.keccak256(sourceContent);
    const source = this.pendingSources[hash];

    if (!source || source.name in this.fetchedSources) {
      return;
    }

    delete this.pendingSources[hash];
    this.fetchedSources[source.name] = sourceContent;

    if (isEmpty(this.pendingSources)) {
      const contract = new CheckedContract(this.metadata, this.fetchedSources);
      this.callback(contract);
    }
  };
}
