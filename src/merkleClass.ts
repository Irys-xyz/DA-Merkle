import { stringToBuffer } from "@irys/arweave/common/lib/utils";
import PromisePool from "@supercharge/promise-pool";
import type CryptoInterface from "@irys/arweave/common/lib/crypto/crypto-interface";
import Arweave from "@irys/arweave";
import { BranchNode, LeafComponents, LeafNode, MerkelNode, NodeTypes, Proof, TreeCtx } from "./types";
import { arrayCompare, bigIntToBuffer, bufferToBigInt, bufferToInt, intToBuffer } from "./utils";

import base64url from "base64url";

export class DAMerkle {

    protected timestampSize: number;
    protected relativeTimestampSize: number;
    protected txIdSize: number;
    protected baseTimestamp: bigint;
    protected noteSize: number;
    protected hashSize: number;

    protected hashFn: CryptoInterface["hash"];
    protected arweave: Arweave;
    protected treeRoot: BranchNode | undefined;


    get root(): BranchNode {
        if (!this.treeRoot) throw new Error("Tree is undefined");
        return this.treeRoot;
    }

    get rootId(): string {
        return base64url.encode(this.root.id);
    }

    set root(root: BranchNode) {
        this.treeRoot = root;
    }

    set treeCtx(ctx: TreeCtx) {
        this.timestampSize = ctx.timestampSize;
        this.relativeTimestampSize = ctx.relativeTimestampSize;
        this.txIdSize = ctx.txIdSize;
        this.baseTimestamp = ctx.baseTimestamp;
        this.noteSize = ctx.noteSize;
        this.hashSize = ctx.hashSize;
    }

    get ctx(): TreeCtx {
        return { timestampSize: this.timestampSize, relativeTimestampSize: this.relativeTimestampSize, txIdSize: this.txIdSize, baseTimestamp: this.baseTimestamp, noteSize: this.noteSize, hashSize: this.hashSize };
    }

    constructor({ arweave = new Arweave(), ctx }: { arweave?: Arweave, ctx?: TreeCtx; }) {
        this.arweave = arweave;
        this.hashFn = arweave.crypto.hash;
        if (ctx) this.treeCtx = ctx;
    }

    async hash(data: Uint8Array | Uint8Array[]): Promise<Uint8Array> {
        if (Array.isArray(data)) {
            data = Arweave.utils.concatBuffers(data);
        }
        return this.arweave.crypto.hash(data);
    }
    // TODO: thread pool?
    public async generateLeaves(txs: LeafComponents[],): Promise<LeafNode[]> {
        const p = await PromisePool.for(txs).useCorrespondingResults().withConcurrency(100).process(async (tx): Promise<LeafNode> => this.generateLeaf(tx));
        if (p.errors.length) throw new Error(`Leaf processing errors - ${JSON.stringify(p.errors)}`);
        return p.results;
    }

    public generateOffset(tx: Pick<LeafComponents, "timestamp" | "txId">) {
        // return 
        const txIdBytes = this.txIdSize;
        const timestampBytes = this.timestampSize;
        const bufId = stringToBuffer(tx.txId);
        const ts = bigIntToBuffer(BigInt(+tx.timestamp) - this.baseTimestamp, timestampBytes);
        const txIdEnc = Buffer.from(bufId.subarray(0, txIdBytes));
        const offset = bufferToBigInt(Buffer.concat([ts, txIdEnc]));
        return offset;

    }

    public async generateLeaf(tx: LeafComponents): Promise<LeafNode> {
        const bufId = stringToBuffer(tx.txId);
        const offset = this.generateOffset(tx);
        const partHash = Buffer.from(await this.hash([stringToBuffer(tx.app), stringToBuffer(tx.version), bufId, stringToBuffer(tx.height), stringToBuffer(tx.timestamp), stringToBuffer(tx.signature)]));
        const biOffset = bigIntToBuffer(offset, this.timestampSize + this.txIdSize);
        const idInputs = [await this.hash(partHash), await this.hash(biOffset)];
        const id = Buffer.from(await this.hash(idInputs));
        return {
            type: "leaf",
            maxOffset: offset,
            offset: offset,
            minOffset: offset,
            id: id,
            hash: partHash
        };
    }


    protected async buildLayers(
        nodes: MerkelNode[],
        level = 0
    ): Promise<BranchNode> {
        // If there is only 1 node left, this is going to be the root node
        if (nodes.length < 2) {
            const root = nodes[0];
            return root as BranchNode;
        }

        const nextLayer: BranchNode[] = [];

        for (let i = 0; i < nodes.length; i += 2) {
            nextLayer.push(await this.hashBranch(nodes[i], nodes[i + 1],));
        }
        return this.buildLayers(nextLayer, level + 1);
    }
    public generateAllProofs() {
        const proofs = this.generateProofs(this.root);
        if (!Array.isArray(proofs)) {
            return [proofs];
        }
        return proofs.flat(Infinity);
    }


    protected generateProofs(
        node: MerkelNode,
        proof: Buffer = Buffer.alloc(0),
        depth = 0,
    ): Proof | Proof[] {
        if (node.type == "leaf") {
            const offsetBuf = bigIntToBuffer(node.maxOffset, this.timestampSize + this.txIdSize);
            const conv = bufferToBigInt(offsetBuf);
            if (conv !== node.maxOffset) throw new Error("encoding error");
            const components = [
                proof,
                node.hash,
                // all offset values are equal for leaves
                bigIntToBuffer(node.maxOffset, this.timestampSize + this.txIdSize),
            ];
            const leafProof = Buffer.concat(components);
            return {
                offset: node.maxOffset,
                proof: leafProof
            };
        }

        if (node.type == "branch") {
            const components = [
                proof,
                node.leftChild!.id!,
                node.rightChild!.id!,
                bigIntToBuffer(node.offset, this.timestampSize + this.txIdSize),
            ];
            const partialProof = Buffer.concat(components);
            return [
                this.generateProofs(node.leftChild!, partialProof, depth + 1,),
                this.generateProofs(node.rightChild!, partialProof, depth + 1,),
            ] as [Proof, Proof];
        }

        throw new Error(`Unexpected node type`);
    }




    public async generateProof(targetOffset: bigint) {
        return this.generateProofWalk(this.root, targetOffset);
    }

    async generateProofWalk(
        node: MerkelNode,
        targetOffset: bigint,
        proof: Buffer = Buffer.alloc(0),
        depth = 0,
    ): Promise<Proof> {
        if (node.type == "leaf") {
            if (node.offset !== targetOffset) throw new Error("Resolved to wrong leaf");
            // TODO: remove
            const offsetBuf = bigIntToBuffer(node.maxOffset, this.timestampSize + this.txIdSize);
            const conv = bufferToBigInt(offsetBuf);
            if (conv !== node.maxOffset) throw new Error("encoding error");

            const components = [
                proof,
                node.hash,
                bigIntToBuffer(node.maxOffset, this.timestampSize + this.txIdSize),
            ];
            const leafProof = Buffer.concat(components);
            return {
                offset: node.maxOffset,
                proof: leafProof
            };
        }

        if (node.type == "branch") {

            const components = [
                proof,
                node.leftChild!.id!,
                node.rightChild!.id!,
                bigIntToBuffer(node.offset, this.timestampSize + this.txIdSize),
            ];
            const partialProof = Buffer.concat(components);
            let nextNode;

            if (targetOffset <= node.leftChild!.maxOffset) { nextNode = node.leftChild!; }
            else if (targetOffset >= node.rightChild!.minOffset) { nextNode = node.rightChild!; } else {
                throw new Error("unable to resolve leaf");
            }
            return this.generateProofWalk(nextNode, targetOffset, partialProof, depth + 1);
        }

        throw new Error(`Unexpected node type`);
    }


    public async hashBranch(
        left: MerkelNode,
        right: MerkelNode
    ): Promise<BranchNode> {
        if (!right) {
            return left as BranchNode;
        }
        const offsetBuf = bigIntToBuffer(left.maxOffset, this.noteSize);
        const hashComponents = [
            await this.hash(left.id),
            await this.hash(right.id),
            await this.hash(offsetBuf),
        ];

        let branch = {
            type: "branch",
            id: await this.hash(hashComponents),
            // components: components,
            offset: left.maxOffset,
            maxOffset: right.maxOffset,
            minOffset: left.minOffset,
            leftChild: left,
            rightChild: right,
        } as BranchNode;

        return branch;
    }

    // async validateProof()



    public serializeWalk(buf: Buffer, node: MerkelNode,): Buffer {
        if (node.type === "leaf") return this.serializeNode(node);

        const bufs: Buffer[] = [];
        if (node.leftChild) {
            const lcBuf = this.serializeWalk(buf, node.leftChild,);
            bufs.push(lcBuf);
        }
        // then right
        if (node.rightChild) {
            const rcBuf = this.serializeWalk(buf, node.rightChild,);
            bufs.push(rcBuf);

        }
        // then we write this node, and unwind.
        const parentBuf = this.serializeNode(node,);
        const b = Buffer.concat([buf, ...bufs, parentBuf]);
        return b;
    }

    public serializeNode(node: MerkelNode,): Buffer {
        switch (node.type) {
            case "branch": {
                // serialize the ID - we can regain offset bounds as we rebuild the tree from the leaves.
                // brackets around type is so it uses it as a value, instead of a length.
                const b = Buffer.concat([new Uint8Array([NodeTypes.BRANCH]), node.id]);
                // console.log("ser", "branch", b.length, node.id.subarray(0,5))
                return b;
            }
            case "leaf": {
                // apply relative timestamp compression here
                // const noteSize = this.relativeTimestampSize + this.txIdSize;
                const offsetBytes = bigIntToBuffer(node.offset, this.timestampSize + this.txIdSize);
                const tsBytes = offsetBytes.subarray(0, this.timestampSize);
                const tsInt = bufferToBigInt(tsBytes); /* - this.baseTimestamp; */
                const tsEncBytes = bigIntToBuffer(tsInt, this.relativeTimestampSize);
                const txIdEncBytes = offsetBytes.subarray(this.timestampSize, this.timestampSize + this.txIdSize);
                const relativeOffsetBytes = Buffer.concat([tsEncBytes, txIdEncBytes]);
                const b = Buffer.concat([new Uint8Array([NodeTypes.LEAF]), node.id, node.hash, relativeOffsetBytes]);
                // console.log("ser", "leaf", b.length,  node.id.subarray(0,5))
                return b;
            }
            default: throw new Error(`Unknown node ${JSON.stringify(node)}`);
        }
    }


    public async serialize() {
        const rootNode = this.root;
        if (!rootNode) throw new Error("root node is undefined");
        // let offset = 0;
        let header = Buffer.alloc(0);
        const write = (bytes: number[] | Uint8Array) => {
            bytes = Array.isArray(bytes) ? new Uint8Array(bytes) : bytes;
            //   header = safeSet(header, bytes, offset);
            //   offset += bytes.length;
            header = Buffer.concat([header, bytes]);
        };
        // let header = Buffer.alloc(0);
        // version
        write([1]);
        // base timestamp bytes
        const tsBuf = bigIntToBuffer(this.baseTimestamp, this.timestampSize);
        // number of bytes leaves use to store timestamps
        write([this.relativeTimestampSize]);
        // store the length of the base timestamp and the base timestamp itself
        write([tsBuf.length]);
        write(tsBuf);

        //store the number of txId bytes
        write([this.txIdSize]);


        // post-order serialization 
        // walk left & right, then root.
        const leftRes = this.serializeWalk(Buffer.alloc(0), rootNode.leftChild!,);
        const rightRes = this.serializeWalk(Buffer.alloc(0), rootNode.rightChild!,);
        const rootRes = this.serializeNode(rootNode,);
        const serialized = Buffer.concat([header, leftRes, rightRes, rootRes]);

        return serialized;
    }

    public preprocessTxs(txs: LeafComponents[]) {
        let txIdSize = 0; // default
        let timestampSize = 6; //default
        const sortFunction = (a: LeafComponents, b: LeafComponents) => {
            const td = +a.timestamp - +b.timestamp;
            // secondary ordering by txId
            if (td === 0) {
                // throw - we can't discriminate between/route these.
                if (a.txId === b.txId) throw new Error(`Illegal duplicate timestamp & txId ${a.timestamp} ${a.txId}`);
                // we need to check exactly how similar these txIds are - if they're too similar, 
                // we need to increase the number of txId bytes we include in the routing key
                // this is an edge case, as it does require the txs to have the exact same timestamp.
                if (txIdSize === 0) txIdSize = 1;
                const iMax = Math.min(a.txId.length, b.txId.length);

                for (let i = 0; i < iMax; i++) {
                    const aChar = a.txId[i];
                    const bChar = b.txId[i];
                    if (aChar !== bChar) break;
                    // txId bytes has to be number of bytes in common, +1. (so +2 total)
                    if (i + 2 > txIdSize) txIdSize = i + 2;
                }

                return a.txId < b.txId ? -1 : 1;

            }
            return td;
        };

        const sorted = txs.sort(sortFunction);

        const baseTimestamp = +sorted.at(0)!.timestamp ?? 0;
        const maxTimestamp = (+sorted.at(-1)!.timestamp);
        const maxRelativeTimestamp = maxTimestamp - baseTimestamp;

        // figure out how many bytes we need to store relative timestamps
        const relativeBytesRequired = Math.ceil(Math.log2(maxRelativeTimestamp) / 8);
        const relativeTest = intToBuffer(maxRelativeTimestamp, relativeBytesRequired);
        const relativeTest2 = bufferToInt(relativeTest);
        if (maxRelativeTimestamp !== relativeTest2) throw new Error("relative timestamp conversion failure");


        // figure out how many bytes we need to store the full timestamp
        const bytesRequired = Math.ceil(Math.log2(maxTimestamp) / 8);
        const test = intToBuffer(maxTimestamp, bytesRequired);
        const test2 = bufferToInt(test);
        if (maxTimestamp !== test2) throw new Error("timestamp conversion failure");
        timestampSize = bytesRequired;
        const ctx: TreeCtx = {
            hashSize: 32,
            timestampSize,
            relativeTimestampSize: relativeBytesRequired,
            baseTimestamp: BigInt(baseTimestamp),
            txIdSize,
            noteSize: timestampSize + txIdSize
        };

        this.treeCtx = ctx;

        return { sorted, ctx };
    }

    async fromTransactions(txs: LeafComponents[]): Promise<this> {
        txs = this.preprocessTxs(txs).sorted;
        const leaves = await this.generateLeaves(txs);
        const root = await this.buildLayers(leaves);
        this.root = root;
        return this;
    }

    static async deserialize(treeBuf: Buffer): Promise<DAMerkle> {
        const leaves: LeafNode[] = [];
        let offset = 0;

        const read = (bytes: number): Buffer => {
            const data = treeBuf.subarray(offset, offset + bytes);
            offset += bytes;
            return data;
        };
        // read header
        const version = read(1)[0];
        if (version !== 1) throw new Error("Unrecognized Irys inclusion tree version!");
        // get the timestamp bytes
        const relativeTsLength = read(1)[0];
        // read the base timestamp
        const baseTsLength = read(1)[0];
        const baseTs = read(baseTsLength);
        // convert to bigint
        const baseTsBigInt = bufferToBigInt(baseTs);
        const txIdLength = read(1)[0];
        // regenerate ctx
        const ctx: TreeCtx = {
            hashSize: 32,
            timestampSize: baseTsLength,
            baseTimestamp: baseTsBigInt,
            relativeTimestampSize: relativeTsLength,
            txIdSize: txIdLength,
            noteSize: baseTsLength + txIdLength
        };

        const nodeStack: MerkelNode[] = [];
        function deserializeWalk() {
            // read the first byte to get the type
            const type = read(1)[0];
            /**  see {@linkcode NodeTypes} */
            switch (type) {
                case NodeTypes.BRANCH:
                    {
                        const right = nodeStack.pop();
                        const left = nodeStack.pop();
                        const branch: BranchNode = {
                            type: "branch",
                            maxOffset: right!.maxOffset,
                            offset: left!.maxOffset,
                            minOffset: left!.minOffset,
                            // slice ID out of the remaining buffer
                            id: read(32),
                            leftChild: left,
                            rightChild: right
                        };
                        nodeStack.push(branch);
                        return branch;
                    }
                case NodeTypes.LEAF:
                    {
                        const id = read(32);
                        const hash = read(32);

                        // read relative timestamp, add base timestamp
                        const ts = bufferToBigInt(read(relativeTsLength)); /* + baseTsBigInt; */
                        // read and add txId
                        const tsBytes = bigIntToBuffer(ts, baseTsLength);
                        const txIdBytes = txIdLength === 0 ? Buffer.alloc(0) : read(txIdLength);
                        const offsetBuf = Buffer.concat([tsBytes, txIdBytes]);
                        const offset = bufferToBigInt(offsetBuf);
                        const node: LeafNode = {
                            type: "leaf",
                            id,
                            hash,
                            // offsetBuf: [tsBytes, txIdBytes],
                            offset: offset,
                            maxOffset: offset,
                            minOffset: offset
                        };
                        nodeStack.push(node);
                        leaves.push(node);
                        return node;
                    }
                default:
                    throw new Error(`Invalid node type ${type}`);
            }
        }
        let t;
        while (offset != treeBuf.length) {
            t = deserializeWalk();
            // return last T value
        }
        const tree = new DAMerkle({ ctx });
        tree.root = t;
        return tree;
    }

}


export async function validateProof(
    id: Uint8Array,
    dest: bigint,
    path: Buffer, ctx: Pick<TreeCtx, "timestampSize" | "txIdSize" | "hashSize"> & { hash: (data: Uint8Array | Uint8Array[]) => Promise<Uint8Array> | Uint8Array; }): Promise<boolean
    > {

    const noteSize = ctx.timestampSize + ctx.txIdSize;

    // if we're at a leaf
    if (path.length == ctx.hashSize + noteSize) {
        const pathData = path.subarray(0, ctx.hashSize);
        const endOffsetBuffer = path.subarray(
            pathData.length,
            pathData.length + noteSize
        );
        // validate the offsets line up
        const endOffset = bufferToBigInt(endOffsetBuffer);
        if (endOffset != dest) return false;
        // re-create leaf ID here
        const pathDataHash = await ctx.hash([
            await ctx.hash(pathData),
            await ctx.hash(endOffsetBuffer),
        ]);

        return arrayCompare(id, pathDataHash);
    }

    // branch case
    const left = path.subarray(0, ctx.hashSize); // left.id
    const right = path.subarray(left.length, left.length + ctx.hashSize); // right.id
    const offsetBuffer = path.subarray(
        left.length + right.length,
        left.length + right.length + noteSize
    );

    // should be left.maxOffset
    const offset = bufferToBigInt(offsetBuffer);

    const remainder = path.subarray(
        left.length + right.length + offsetBuffer.length
    );

    const pathHash = await ctx.hash([
        await ctx.hash(left),
        await ctx.hash(right),
        await ctx.hash(offsetBuffer),
    ]);

    if (arrayCompare(id, pathHash)) {
        // slide to the left~
        if (dest <= offset) {
            return await validateProof(
                left,
                dest,
                remainder, ctx
            );
        }
        // slide to the right~
        return await validateProof(
            right,
            dest,
            remainder,
            ctx
        );
    }
    // criss cro... return false
    return false;
}



