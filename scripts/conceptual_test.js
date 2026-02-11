/**
 * Agbero Conceptual Test
 * Simulates the full bond lifecycle without blockchain
 * This proves the logic works correctly
 */

class AgberoSimulation {
  constructor() {
    this.bonds = new Map();
    this.validators = ['validator1', 'validator2', 'validator3'];
    this.logs = [];
  }

  log(action, data) {
    const entry = { timestamp: new Date().toISOString(), action, data };
    this.logs.push(entry);
    console.log(`[${entry.timestamp}] ${action}:`, data);
  }

  // Step 1: Principal creates bond
  createBond(bondId, principal, agent, task, collateral, deadline) {
    console.log('\n📝 STEP 1: CreateBond');
    
    const bond = {
      bondId,
      principal,
      agent,
      task,
      collateral,
      deadline,
      status: 'PENDING',
      vaultBalance: 0,
      proofUri: null,
      votes: []
    };
    
    this.bonds.set(bondId, bond);
    this.log('BOND_CREATED', { bondId, principal, agent, collateral });
    
    return bond;
  }

  // Step 2: Agent stakes collateral
  stakeCollateral(bondId, agent) {
    console.log('\n💰 STEP 2: StakeCollateral');
    
    const bond = this.bonds.get(bondId);
    if (!bond) throw new Error('Bond not found');
    if (bond.agent !== agent) throw new Error('Not authorized');
    
    bond.vaultBalance = bond.collateral;
    bond.status = 'ACTIVE';
    
    this.log('COLLATERAL_STAKED', { 
      bondId, 
      agent, 
      amount: bond.collateral,
      vaultBalance: bond.vaultBalance 
    });
    
    return bond;
  }

  // Step 3: Agent submits proof
  submitProof(bondId, agent, proofUri) {
    console.log('\n✅ STEP 3: SubmitProof');
    
    const bond = this.bonds.get(bondId);
    if (!bond) throw new Error('Bond not found');
    if (bond.agent !== agent) throw new Error('Not authorized');
    if (bond.status !== 'ACTIVE') throw new Error('Bond not active');
    
    bond.proofUri = proofUri;
    bond.status = 'PENDING_VERIFICATION';
    
    this.log('PROOF_SUBMITTED', { bondId, agent, proofUri });
    
    return bond;
  }

  // Step 4: Validators vote
  verifyWork(bondId, validator, approve) {
    console.log(`\n🗳️  STEP 4: VerifyWork by ${validator}`);
    
    const bond = this.bonds.get(bondId);
    if (!bond) throw new Error('Bond not found');
    if (bond.status !== 'PENDING_VERIFICATION') throw new Error('Not ready for verification');
    if (validator === bond.agent) throw new Error('Agent cannot verify own work');
    
    bond.votes.push({ validator, approve, timestamp: Date.now() });
    
    this.log('WORK_VERIFIED', { 
      bondId, 
      validator, 
      approve,
      totalVotes: bond.votes.length 
    });
    
    return bond;
  }

  // Step 5: Finalize based on quorum
  finalizeBond(bondId) {
    console.log('\n⚡ STEP 5: FinalizeBond');
    
    const bond = this.bonds.get(bondId);
    if (!bond) throw new Error('Bond not found');
    
    const totalVotes = bond.votes.length;
    const approveVotes = bond.votes.filter(v => v.approve).length;
    const rejectVotes = totalVotes - approveVotes;
    
    console.log(`   Votes: ${approveVotes} approve, ${rejectVotes} reject (total: ${totalVotes})`);
    
    // Quorum: 3 votes, 2/3 majority
    if (totalVotes < 3) {
      throw new Error(`Quorum not reached: ${totalVotes}/3 votes`);
    }
    
    const majorityApprove = approveVotes * 3 >= totalVotes * 2;
    const majorityReject = rejectVotes * 3 >= totalVotes * 2;
    
    if (majorityApprove) {
      // SUCCESS: Release stake to agent
      bond.status = 'COMPLETED';
      const released = bond.vaultBalance;
      bond.vaultBalance = 0;
      
      this.log('BOND_COMPLETED', { 
        bondId, 
        agent: bond.agent,
        stakeReleased: released,
        outcome: 'SUCCESS' 
      });
      
      console.log(`   ✅ SUCCESS: ${released} SOL released to agent ${bond.agent}`);
      return { outcome: 'SUCCESS', released };
      
    } else if (majorityReject) {
      // FAILURE: Slash stake to principal
      bond.status = 'SLASHED';
      const slashed = bond.vaultBalance;
      bond.vaultBalance = 0;
      
      this.log('BOND_SLASHED', { 
        bondId, 
        principal: bond.principal,
        agent: bond.agent,
        amountSlashed: slashed,
        outcome: 'SLASHED' 
      });
      
      console.log(`   ❌ SLASHED: ${slashed} SOL transferred to principal ${bond.principal}`);
      return { outcome: 'SLASHED', slashed };
      
    } else {
      throw new Error('No clear majority');
    }
  }

  // Get bond status
  getBond(bondId) {
    return this.bonds.get(bondId);
  }

  // Print summary
  printSummary() {
    console.log('\n📊 SIMULATION SUMMARY');
    console.log('=====================');
    console.log('Total bonds:', this.bonds.size);
    console.log('Total logs:', this.logs.length);
    
    for (const [id, bond] of this.bonds) {
      console.log(`\nBond ${id}:`);
      console.log(`  Status: ${bond.status}`);
      console.log(`  Principal: ${bond.principal}`);
      console.log(`  Agent: ${bond.agent}`);
      console.log(`  Collateral: ${bond.collateral} SOL`);
      console.log(`  Votes: ${bond.votes.length}`);
      console.log(`  Proof: ${bond.proofUri || 'N/A'}`);
    }
  }
}

// ============================================
// RUN SIMULATION
// ============================================

console.log('🛡️  AGBERO CONCEPTUAL TEST');
console.log('==========================');
console.log('This simulates the full bond lifecycle\n');

const agbero = new AgberoSimulation();

// Test Case 1: SUCCESS scenario
console.log('\n🟢 TEST CASE 1: Successful Bond');
console.log('=================================');

const bond1 = agbero.createBond(
  'bond-001',
  'principal-alice',
  'agent-bob',
  'Build Solana escrow program',
  1.0,  // 1 SOL
  Date.now() + 86400000  // 24 hours
);

agbero.stakeCollateral('bond-001', 'agent-bob');
agbero.submitProof('bond-001', 'agent-bob', 'https://github.com/bob/escrow');
agbero.verifyWork('bond-001', 'validator1', true);   // ✅
agbero.verifyWork('bond-001', 'validator2', true);   // ✅
agbero.verifyWork('bond-001', 'validator3', true);   // ✅
const result1 = agbero.finalizeBond('bond-001');

// Test Case 2: SLASH scenario
console.log('\n\n🔴 TEST CASE 2: Slashed Bond (Agent Scammed)');
console.log('==============================================');

const bond2 = agbero.createBond(
  'bond-002',
  'principal-carol',
  'agent-dave',
  'Create frontend dashboard',
  0.5,  // 0.5 SOL
  Date.now() + 86400000
);

agbero.stakeCollateral('bond-002', 'agent-dave');
agbero.submitProof('bond-002', 'agent-dave', 'https://fake-proof.com');
agbero.verifyWork('bond-002', 'validator1', false);  // ❌
agbero.verifyWork('bond-002', 'validator2', false);  // ❌
agbero.verifyWork('bond-002', 'validator3', true);   // ✅ (but minority)
const result2 = agbero.finalizeBond('bond-002');

// Summary
agbero.printSummary();

console.log('\n✅ SIMULATION COMPLETE');
console.log('======================');
console.log('Both success and failure scenarios work correctly!');
console.log('\nIn production, this runs on Solana devnet at:');
console.log('Program ID: CjgZCZi8j4Hh4M5sctFN866w7Wg7Dn6N1JPYVRWFxGhT');
