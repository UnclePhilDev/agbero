import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorProvider, web3, BN } from '@coral-xyz/anchor';
import { PublicKey, SystemProgram, Connection, Commitment } from '@solana/web3.js';

/**
 * Agbero SDK - The Enforcer
 * Performance bonds for AI agents on Solana
 */

const PROGRAM_ID = new PublicKey('Agbero1111111111111111111111111111111111111');

export interface Bond {
  bondId: string;
  principal: PublicKey;
  agent: PublicKey;
  taskDescription: string;
  collateralAmount: BN;
  deadline: BN;
  status: BondStatus;
  createdAt: BN;
  completedAt: BN;
  verificationVotes: VerificationVote[];
  proofUri: string;
  bump: number;
}

export interface VerificationVote {
  verifier: PublicKey;
  approve: boolean;
  timestamp: BN;
}

export enum BondStatus {
  Pending = 0,
  Active = 1,
  PendingVerification = 2,
  Completed = 3,
  Slashed = 4,
}

export interface CreateBondParams {
  bondId: string;
  agent: PublicKey;
  taskDescription: string;
  collateralAmount: BN;
  deadline: BN; // Unix timestamp
}

export class AgberoClient {
  program: Program;
  provider: AnchorProvider;

  constructor(provider: AnchorProvider, programId?: PublicKey) {
    this.provider = provider;
    // IDL would be loaded here in production
    this.program = new Program(
      require('./idl.json'),
      programId || PROGRAM_ID,
      provider
    );
  }

  /**
   * Derive bond PDA from bond ID
   */
  getBondPDA(bondId: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('bond'), Buffer.from(bondId)],
      this.program.programId
    );
  }

  /**
   * Derive bond vault PDA
   */
  getBondVaultPDA(bondPDA: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('bond_vault'), bondPDA.toBuffer()],
      this.program.programId
    );
  }

  /**
   * Create a new performance bond
   */
  async createBond(params: CreateBondParams): Promise<string> {
    const [bondPDA] = this.getBondPDA(params.bondId);
    const [bondVaultPDA] = this.getBondVaultPDA(bondPDA);

    const tx = await this.program.methods
      .createBond(
        params.bondId,
        params.taskDescription,
        params.collateralAmount,
        params.deadline
      )
      .accounts({
        principal: this.provider.wallet.publicKey,
        agent: params.agent,
        bond: bondPDA,
        bondVault: bondVaultPDA,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return tx;
  }

  /**
   * Agent stakes collateral to activate bond
   */
  async stakeCollateral(bondId: string): Promise<string> {
    const [bondPDA] = this.getBondPDA(bondId);
    const [bondVaultPDA] = this.getBondVaultPDA(bondPDA);

    const tx = await this.program.methods
      .stakeCollateral()
      .accounts({
        agent: this.provider.wallet.publicKey,
        bond: bondPDA,
        bondVault: bondVaultPDA,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return tx;
  }

  /**
   * Agent submits proof of completion
   */
  async submitProof(bondId: string, proofUri: string): Promise<string> {
    const [bondPDA] = this.getBondPDA(bondId);

    const tx = await this.program.methods
      .submitProof(proofUri)
      .accounts({
        agent: this.provider.wallet.publicKey,
        bond: bondPDA,
      })
      .rpc();

    return tx;
  }

  /**
   * Verifier votes on bond completion
   */
  async verifyWork(bondId: string, approve: boolean): Promise<string> {
    const [bondPDA] = this.getBondPDA(bondId);

    const tx = await this.program.methods
      .verifyWork(approve)
      .accounts({
        verifier: this.provider.wallet.publicKey,
        bond: bondPDA,
      })
      .rpc();

    return tx;
  }

  /**
   * Finalize bond (anyone can call once quorum reached)
   */
  async finalizeBond(bondId: string): Promise<string> {
    const [bondPDA] = this.getBondPDA(bondId);
    const [bondVaultPDA] = this.getBondVaultPDA(bondPDA);

    const bond = await this.getBond(bondId);

    const tx = await this.program.methods
      .finalizeBond()
      .accounts({
        executor: this.provider.wallet.publicKey,
        bond: bondPDA,
        bondVault: bondVaultPDA,
        agent: bond.agent,
        principal: bond.principal,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return tx;
  }

  /**
   * Emergency slash by principal
   */
  async emergencySlash(bondId: string): Promise<string> {
    const [bondPDA] = this.getBondPDA(bondId);
    const [bondVaultPDA] = this.getBondVaultPDA(bondPDA);
    const bond = await this.getBond(bondId);

    const tx = await this.program.methods
      .emergencySlash()
      .accounts({
        principal: this.provider.wallet.publicKey,
        bond: bondPDA,
        bondVault: bondVaultPDA,
        principalVault: bond.principal,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return tx;
  }

  /**
   * Fetch bond account data
   */
  async getBond(bondId: string): Promise<Bond> {
    const [bondPDA] = this.getBondPDA(bondId);
    return await this.program.account.bond.fetch(bondPDA);
  }

  /**
   * Fetch all bonds
   */
  async getAllBonds(): Promise<{ publicKey: PublicKey; account: Bond }[]> {
    return await this.program.account.bond.all();
  }

  /**
   * Fetch bonds by agent
   */
  async getBondsByAgent(agent: PublicKey): Promise<{ publicKey: PublicKey; account: Bond }[]> {
    const allBonds = await this.getAllBonds();
    return allBonds.filter(b => b.account.agent.equals(agent));
  }

  /**
   * Fetch bonds by principal
   */
  async getBondsByPrincipal(principal: PublicKey): Promise<{ publicKey: PublicKey; account: Bond }[]> {
    const allBonds = await this.getAllBonds();
    return allBonds.filter(b => b.account.principal.equals(principal));
  }
}

/**
 * Utility to format bond status for display
 */
export function formatBondStatus(status: BondStatus): string {
  switch (status) {
    case BondStatus.Pending:
      return '⏳ Pending Stake';
    case BondStatus.Active:
      return '🔄 Active';
    case BondStatus.PendingVerification:
      return '🔍 Pending Verification';
    case BondStatus.Completed:
      return '✅ Completed';
    case BondStatus.Slashed:
      return '❌ Slashed';
    default:
      return 'Unknown';
  }
}

/**
 * Check if bond is in slashable state
 */
export function isSlashable(status: BondStatus): boolean {
  return status === BondStatus.Slashed;
}

/**
 * Check if bond is completed
 */
export function isCompleted(status: BondStatus): boolean {
  return status === BondStatus.Completed;
}

export default AgberoClient;
