export type Base64URLString = string;
export type StringifiedNumber = string;


export interface BranchNode {
    readonly type: "branch";
    readonly id: Buffer;
    readonly offset: bigint; //actually left.maxOffset
    readonly maxOffset: bigint;  // right.maxOffset
    readonly minOffset: bigint; // left.minOffset
    readonly leftChild?: MerkelNode;
    readonly rightChild?: MerkelNode;
    // readonly components?: any;
}

export interface LeafNode {
    readonly type: "leaf";
    readonly id: Buffer;
    readonly hash: Buffer;
    // readonly offsetBuf: Buffer[]; // TODO: remove - for debugging
    readonly minOffset: bigint;
    readonly offset: bigint;
    readonly maxOffset: bigint;
}

export type MerkelNode = BranchNode | LeafNode;

export type TreeCtx = {
    timestampSize: number,
    relativeTimestampSize: number,
    txIdSize: number;
    baseTimestamp: bigint,
    noteSize: number;
    hashSize: number;
};


export type LeafComponents = {
    version: "1.0.0",
    app: "Bundlr",
    txId: string,
    height: StringifiedNumber;
    timestamp: StringifiedNumber;
    signature: Base64URLString;
};


export interface Proof {
    offset: bigint;
    proof: Buffer;
}

export enum NodeTypes {
    BRANCH = 0,
    LEAF = 1
}
