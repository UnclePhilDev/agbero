/**
 * Agbero Autonomous Validator Agent
 * 
 * This agent autonomously monitors bonds, verifies work submissions,
 * and votes on bond completion. It runs 24/7 as a "Most Agentic" demonstration.
 * 
 * Key autonomous behaviors:
 * 1. Monitors blockchain for new bonds in PendingVerification state
 * 2. Fetches proof URIs and evaluates work quality
 * 3. Casts verification votes based on objective criteria
 * 4. Calls finalize_bond when quorum is reached
 * 5. Logs all actions on-chain for transparency
 */

import * as anchor from '@coral-xyz/anchor';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import AgberoClient, { Bond, BondStatus } from '../sdk/src';

interface ValidatorConfig {
  rpcUrl: string;
  programId: string;
  validatorKeypair: Keypair;
  verificationCriteria: VerificationCriteria;
  checkIntervalMs: number;
}

interface VerificationCriteria {
  minProofLength: number;
  requiredProofKeywords: string[];
  autoApproveThreshold: number; // Confidence score 0-100
}

class AgberoValidator {
  private client: AgberoClient;
  private connection: Connection;
  private config: ValidatorConfig;
  private isRunning: boolean = false;
  private processedBonds: Set<string> = new Set();

  // Activity log for "Proof of Work" transparency
  private activityLog: Activity[] = [];

  constructor(config: ValidatorConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    
    const provider = new anchor.AnchorProvider(
      this.connection,
      new anchor.Wallet(config.validatorKeypair),
      { commitment: 'confirmed' }
    );
    
    this.client = new AgberoClient(provider, new PublicKey(config.programId));
  }

  /**
   * Start autonomous validation loop
   */
  async start(): Promise<void> {
    console.log('🤖 Agbero Validator Agent starting...');
    console.log(`Validator: ${this.config.validatorKeypair.publicKey.toBase58()}`);
    
    this.isRunning = true;
    
    while (this.isRunning) {
      try {
        await this.checkAndVerifyBonds();
        await this.finalizeReadyBonds();
        this.logActivity('cycle_complete', {});
      } catch (error) {
        console.error('Validator error:', error);
        this.logActivity('error', { error: error.message });
      }
      
      await this.sleep(this.config.checkIntervalMs);
    }
  }

  /**
   * Check for bonds pending verification and vote
   */
  private async checkAndVerifyBonds(): Promise<void> {
    const bonds = await this.client.getAllBonds();
    
    for (const { publicKey, account } of bonds) {
      // Skip if already processed
      if (this.processedBonds.has(account.bondId)) continue;
      
      // Only process bonds in PendingVerification status
      if (account.status !== BondStatus.PendingVerification) continue;
      
      // Skip if already voted
      const alreadyVoted = account.verificationVotes.some(
        v => v.verifier.toBase58() === this.config.validatorKeypair.publicKey.toBase58()
      );
      if (alreadyVoted) continue;

      console.log(`🔍 Evaluating bond: ${account.bondId}`);
      
      // Autonomous evaluation
      const evaluation = await this.evaluateWork(account);
      
      // Cast vote
      try {
        const tx = await this.client.verifyWork(account.bondId, evaluation.approve);
        console.log(`✅ Voted ${evaluation.approve ? 'APPROVE' : 'REJECT'} on ${account.bondId}`);
        console.log(`   Reason: ${evaluation.reason}`);
        console.log(`   Tx: ${tx}`);
        
        this.logActivity('vote_cast', {
          bondId: account.bondId,
          approve: evaluation.approve,
          reason: evaluation.reason,
          confidence: evaluation.confidence,
          tx
        });
        
        this.processedBonds.add(account.bondId);
      } catch (error) {
        console.error(`Failed to vote on ${account.bondId}:`, error);
      }
    }
  }

  /**
   * Evaluate work submission autonomously
   */
  private async evaluateWork(bond: Bond): Promise<EvaluationResult> {
    const proofUri = bond.proofUri;
    
    // Check if proof URI exists
    if (!proofUri || proofUri.length < this.config.verificationCriteria.minProofLength) {
      return {
        approve: false,
        reason: 'Proof URI missing or too short',
        confidence: 95
      };
    }

    // Fetch and analyze proof
    try {
      const proofContent = await this.fetchProof(proofUri);
      
      // Check for required keywords
      const hasRequiredKeywords = this.config.verificationCriteria.requiredProofKeywords.every(
        keyword => proofContent.toLowerCase().includes(keyword.toLowerCase())
      );

      // Simple heuristic: longer proofs with keywords = more likely valid
      const lengthScore = Math.min(proofContent.length / 1000, 1) * 30;
      const keywordScore = hasRequiredKeywords ? 40 : 0;
      const confidence = Math.min(lengthScore + keywordScore + 30, 100);

      const approve = confidence >= this.config.verificationCriteria.autoApproveThreshold;

      return {
        approve,
        reason: approve 
          ? `Proof meets criteria (${proofContent.length} chars, keywords: ${hasRequiredKeywords})`
          : `Proof below threshold (${confidence.toFixed(1)}% confidence)`,
        confidence
      };

    } catch (error) {
      // If we can't fetch proof, reject
      return {
        approve: false,
        reason: `Failed to fetch proof: ${error.message}`,
        confidence: 100
      };
    }
  }

  /**
   * Fetch proof from URI
   */
  private async fetchProof(uri: string): Promise<string> {
    // Support various URI schemes
    if (uri.startsWith('http://') || uri.startsWith('https://')) {
      const response = await fetch(uri);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    }
    
    if (uri.startsWith('ipfs://')) {
      const cid = uri.replace('ipfs://', '');
      const response = await fetch(`https://ipfs.io/ipfs/${cid}`);
      if (!response.ok) throw new Error(`IPFS fetch failed`);
      return await response.text();
    }

    if (uri.startsWith('ar://')) {
      const txId = uri.replace('ar://', '');
      const response = await fetch(`https://arweave.net/${txId}`);
      if (!response.ok) throw new Error(`Arweave fetch failed`);
      return await response.text();
    }

    // Assume raw string proof
    return uri;
  }

  /**
   * Finalize bonds that have reached quorum
   */
  private async finalizeReadyBonds(): Promise<void> {
    const bonds = await this.client.getAllBonds();
    
    for (const { account } of bonds) {
      // Only process PendingVerification bonds
      if (account.status !== BondStatus.PendingVerification) continue;
      
      const totalVotes = account.verificationVotes.length;
      const approveVotes = account.verificationVotes.filter(v => v.approve).length;
      const slashVotes = totalVotes - approveVotes;

      // Check if quorum reached (3 votes, 2/3 majority)
      const quorumReached = totalVotes >= 3;
      const majorityDecided = (approveVotes * 3 >= totalVotes * 2) || 
                              (slashVotes * 3 >= totalVotes * 2);

      if (quorumReached && majorityDecided) {
        console.log(`🎯 Finalizing bond: ${account.bondId}`);
        
        try {
          const tx = await this.client.finalizeBond(account.bondId);
          const outcome = approveVotes > slashVotes ? 'COMPLETED' : 'SLASHED';
          
          console.log(`✅ Bond ${outcome}! Tx: ${tx}`);
          
          this.logActivity('bond_finalized', {
            bondId: account.bondId,
            outcome,
            approveVotes,
            slashVotes,
            tx
          });
        } catch (error) {
          console.error(`Failed to finalize ${account.bondId}:`, error);
        }
      }
    }
  }

  /**
   * Log activity for transparency
   */
  private logActivity(action: string, data: any): void {
    const activity: Activity = {
      timestamp: new Date().toISOString(),
      action,
      data,
      validator: this.config.validatorKeypair.publicKey.toBase58()
    };
    
    this.activityLog.push(activity);
    
    // In production: anchor this to Solana via memo program
    console.log(`[${activity.timestamp}] ${action}:`, data);
  }

  /**
   * Get activity log for "Proof of Work" display
   */
  getActivityLog(): Activity[] {
    return this.activityLog;
  }

  /**
   * Stop the validator
   */
  stop(): void {
    this.isRunning = false;
    console.log('🛑 Validator stopped');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

interface EvaluationResult {
  approve: boolean;
  reason: string;
  confidence: number;
}

interface Activity {
  timestamp: string;
  action: string;
  data: any;
  validator: string;
}

// Auto-run if called directly
if (require.main === module) {
  const config: ValidatorConfig = {
    rpcUrl: process.env.RPC_URL || 'https://api.devnet.solana.com',
    programId: process.env.PROGRAM_ID || 'Agbero1111111111111111111111111111111111111',
    validatorKeypair: Keypair.fromSecretKey(
      Buffer.from(JSON.parse(process.env.VALIDATOR_KEYPAIR || '[]'))
    ),
    verificationCriteria: {
      minProofLength: 10,
      requiredProofKeywords: ['completed', 'done', 'finished'],
      autoApproveThreshold: 70
    },
    checkIntervalMs: 30000 // 30 seconds
  };

  const validator = new AgberoValidator(config);
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    validator.stop();
    process.exit(0);
  });

  validator.start();
}

export default AgberoValidator;
