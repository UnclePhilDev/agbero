import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Agbero } from '../target/types/agbero';
import { expect } from 'chai';
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';

describe('Agbero - Performance Bonds', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Agbero as Program<Agbero>;
  
  // Test accounts
  const principal = anchor.web3.Keypair.generate();
  const agent = anchor.web3.Keypair.generate();
  const verifier1 = anchor.web3.Keypair.generate();
  const verifier2 = anchor.web3.Keypair.generate();
  const verifier3 = anchor.web3.Keypair.generate();

  const bondId = 'test-bond-001';
  let bondPDA: PublicKey;
  let bondVaultPDA: PublicKey;
  let bump: number;

  before(async () => {
    // Airdrop SOL to test accounts
    const signatures = await Promise.all([
      provider.connection.requestAirdrop(principal.publicKey, 10 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(agent.publicKey, 10 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(verifier1.publicKey, 1 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(verifier2.publicKey, 1 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(verifier3.publicKey, 1 * LAMPORTS_PER_SOL),
    ]);
    
    await Promise.all(signatures.map(sig => provider.connection.confirmTransaction(sig)));

    // Derive PDAs
    [bondPDA, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('bond'), Buffer.from(bondId)],
      program.programId
    );
    
    [bondVaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('bond_vault'), bondPDA.toBuffer()],
      program.programId
    );
  });

  it('Creates a bond', async () => {
    const deadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now
    const collateralAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);

    await program.methods
      .createBond(
        bondId,
        'Build a Solana escrow program',
        collateralAmount,
        new anchor.BN(deadline)
      )
      .accounts({
        principal: principal.publicKey,
        agent: agent.publicKey,
        bond: bondPDA,
        bondVault: bondVaultPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([principal])
      .rpc();

    const bond = await program.account.bond.fetch(bondPDA);
    
    expect(bond.bondId).to.equal(bondId);
    expect(bond.principal.toBase58()).to.equal(principal.publicKey.toBase58());
    expect(bond.agent.toBase58()).to.equal(agent.publicKey.toBase58());
    expect(bond.collateralAmount.toNumber()).to.equal(collateralAmount.toNumber());
    expect(bond.status).to.deep.equal({ pending: {} });
  });

  it('Agent stakes collateral', async () => {
    const bondBefore = await program.account.bond.fetch(bondPDA);
    const vaultBalanceBefore = await provider.connection.getBalance(bondVaultPDA);

    await program.methods
      .stakeCollateral()
      .accounts({
        agent: agent.publicKey,
        bond: bondPDA,
        bondVault: bondVaultPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();

    const bondAfter = await program.account.bond.fetch(bondPDA);
    const vaultBalanceAfter = await provider.connection.getBalance(bondVaultPDA);

    expect(bondAfter.status).to.deep.equal({ active: {} });
    expect(vaultBalanceAfter - vaultBalanceBefore).to.equal(bondBefore.collateralAmount.toNumber());
  });

  it('Agent submits proof', async () => {
    const proofUri = 'https://github.com/example/repo/commit/abc123';

    await program.methods
      .submitProof(proofUri)
      .accounts({
        agent: agent.publicKey,
        bond: bondPDA,
      })
      .signers([agent])
      .rpc();

    const bond = await program.account.bond.fetch(bondPDA);
    
    expect(bond.proofUri).to.equal(proofUri);
    expect(bond.status).to.deep.equal({ pendingVerification: {} });
  });

  it('Verifiers cast votes', async () => {
    // Verifier 1 approves
    await program.methods
      .verifyWork(true)
      .accounts({
        verifier: verifier1.publicKey,
        bond: bondPDA,
      })
      .signers([verifier1])
      .rpc();

    // Verifier 2 approves
    await program.methods
      .verifyWork(true)
      .accounts({
        verifier: verifier2.publicKey,
        bond: bondPDA,
      })
      .signers([verifier2])
      .rpc();

    // Verifier 3 approves
    await program.methods
      .verifyWork(true)
      .accounts({
        verifier: verifier3.publicKey,
        bond: bondPDA,
      })
      .signers([verifier3])
      .rpc();

    const bond = await program.account.bond.fetch(bondPDA);
    
    expect(bond.verificationVotes.length).to.equal(3);
    expect(bond.verificationVotes.filter(v => v.approve).length).to.equal(3);
  });

  it('Finalizes bond and releases stake', async () => {
    const agentBalanceBefore = await provider.connection.getBalance(agent.publicKey);

    await program.methods
      .finalizeBond()
      .accounts({
        executor: verifier1.publicKey,
        bond: bondPDA,
        bondVault: bondVaultPDA,
        agent: agent.publicKey,
        principal: principal.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([verifier1])
      .rpc();

    const bond = await program.account.bond.fetch(bondPDA);
    const agentBalanceAfter = await provider.connection.getBalance(agent.publicKey);

    expect(bond.status).to.deep.equal({ completed: {} });
    expect(agentBalanceAfter).to.be.greaterThan(agentBalanceBefore);
  });

  it('Creates and slashes a fraudulent bond', async () => {
    const fraudBondId = 'fraud-bond-001';
    
    const [fraudBondPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('bond'), Buffer.from(fraudBondId)],
      program.programId
    );
    
    const [fraudVaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('bond_vault'), fraudBondPDA.toBuffer()],
      program.programId
    );

    const deadline = Math.floor(Date.now() / 1000) + 86400;
    const collateralAmount = new anchor.BN(0.5 * LAMPORTS_PER_SOL);

    // Create bond
    await program.methods
      .createBond(
        fraudBondId,
        'Fraudulent task',
        collateralAmount,
        new anchor.BN(deadline)
      )
      .accounts({
        principal: principal.publicKey,
        agent: agent.publicKey,
        bond: fraudBondPDA,
        bondVault: fraudVaultPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([principal])
      .rpc();

    // Stake
    await program.methods
      .stakeCollateral()
      .accounts({
        agent: agent.publicKey,
        bond: fraudBondPDA,
        bondVault: fraudVaultPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();

    // Submit proof
    await program.methods
      .submitProof('https://fake-proof.com')
      .accounts({
        agent: agent.publicKey,
        bond: fraudBondPDA,
      })
      .signers([agent])
      .rpc();

    // Verifiers reject (2 reject, 1 approve)
    await program.methods
      .verifyWork(false)
      .accounts({
        verifier: verifier1.publicKey,
        bond: fraudBondPDA,
      })
      .signers([verifier1])
      .rpc();

    await program.methods
      .verifyWork(false)
      .accounts({
        verifier: verifier2.publicKey,
        bond: fraudBondPDA,
      })
      .signers([verifier2])
      .rpc();

    await program.methods
      .verifyWork(true)
      .accounts({
        verifier: verifier3.publicKey,
        bond: fraudBondPDA,
      })
      .signers([verifier3])
      .rpc();

    const principalBalanceBefore = await provider.connection.getBalance(principal.publicKey);

    // Finalize - should slash
    await program.methods
      .finalizeBond()
      .accounts({
        executor: verifier1.publicKey,
        bond: fraudBondPDA,
        bondVault: fraudVaultPDA,
        agent: agent.publicKey,
        principal: principal.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([verifier1])
      .rpc();

    const fraudBond = await program.account.bond.fetch(fraudBondPDA);
    const principalBalanceAfter = await provider.connection.getBalance(principal.publicKey);

    expect(fraudBond.status).to.deep.equal({ slashed: {} });
    expect(principalBalanceAfter).to.be.greaterThan(principalBalanceBefore);
  });
});
