use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

// Agbero: The Enforcer
// Performance bonds for AI agents
// Fail or scam → get slashed

declare_id!("Agbero1111111111111111111111111111111111111");

#[program]
pub mod agbero {
    use super::*;

    /// Create a new performance bond
    /// Caller (principal) defines task, collateral amount, and verifier
    pub fn create_bond(
        ctx: Context<CreateBond>,
        bond_id: String,
        task_description: String,
        collateral_amount: u64,
        deadline: i64,
    ) -> Result<()> {
        require!(
            task_description.len() <= 500,
            AgberoError::DescriptionTooLong
        );
        require!(collateral_amount >= 1_000_000, AgberoError::CollateralTooLow); // 0.001 SOL min
        require!(deadline > Clock::get()?.unix_timestamp, AgberoError::InvalidDeadline);

        let bond = &mut ctx.accounts.bond;
        bond.bond_id = bond_id;
        bond.principal = ctx.accounts.principal.key();
        bond.agent = ctx.accounts.agent.key();
        bond.task_description = task_description;
        bond.collateral_amount = collateral_amount;
        bond.deadline = deadline;
        bond.status = BondStatus::Pending;
        bond.created_at = Clock::get()?.unix_timestamp;
        bond.completed_at = 0;
        bond.verification_votes = vec![];
        bond.slash_votes = vec![];
        bond.proof_uri = String::new();
        bond.bump = ctx.bumps.bond;

        emit!(BondCreated {
            bond_id: bond.bond_id.clone(),
            principal: bond.principal,
            agent: bond.agent,
            collateral_amount,
            deadline,
        });

        msg!("Bond created: {}", bond.bond_id);
        Ok(())
    }

    /// Agent stakes collateral to activate bond
    pub fn stake_collateral(ctx: Context<StakeCollateral>) -> Result<()> {
        let bond = &mut ctx.accounts.bond;
        
        require!(
            bond.status == BondStatus::Pending,
            AgberoError::InvalidBondStatus
        );
        require!(
            ctx.accounts.agent.key() == bond.agent,
            AgberoError::UnauthorizedAgent
        );

        // Transfer collateral from agent to bond vault
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.agent.to_account_info(),
                to: ctx.accounts.bond_vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, bond.collateral_amount)?;

        bond.status = BondStatus::Active;

        emit!(CollateralStaked {
            bond_id: bond.bond_id.clone(),
            agent: bond.agent,
            amount: bond.collateral_amount,
        });

        msg!("Collateral staked: {} lamports", bond.collateral_amount);
        Ok(())
    }

    /// Agent submits proof of completion
    pub fn submit_proof(ctx: Context<SubmitProof>, proof_uri: String) -> Result<()> {
        let bond = &mut ctx.accounts.bond;
        
        require!(
            bond.status == BondStatus::Active,
            AgberoError::InvalidBondStatus
        );
        require!(
            ctx.accounts.agent.key() == bond.agent,
            AgberoError::UnauthorizedAgent
        );
        require!(
            Clock::get()?.unix_timestamp <= bond.deadline,
            AgberoError::DeadlineExceeded
        );
        require!(proof_uri.len() <= 200, AgberoError::ProofUriTooLong);

        bond.proof_uri = proof_uri;
        bond.status = BondStatus::PendingVerification;

        emit!(ProofSubmitted {
            bond_id: bond.bond_id.clone(),
            agent: bond.agent,
            proof_uri: bond.proof_uri.clone(),
        });

        msg!("Proof submitted for bond: {}", bond.bond_id);
        Ok(())
    }

    /// Verifier votes on bond completion (yes/no)
    /// For MVP: anyone can verify (decentralized oracle network)
    pub fn verify_work(ctx: Context<VerifyWork>, approve: bool) -> Result<()> {
        let bond = &mut ctx.accounts.bond;
        
        require!(
            bond.status == BondStatus::PendingVerification,
            AgberoError::InvalidBondStatus
        );
        require!(
            ctx.accounts.verifier.key() != bond.agent,
            AgberoError::AgentCannotVerify
        );

        let vote = VerificationVote {
            verifier: ctx.accounts.verifier.key(),
            approve,
            timestamp: Clock::get()?.unix_timestamp,
        };
        
        bond.verification_votes.push(vote);

        emit!(WorkVerified {
            bond_id: bond.bond_id.clone(),
            verifier: ctx.accounts.verifier.key(),
            approve,
        });

        msg!("Verification vote recorded for bond: {}", bond.bond_id);
        Ok(())
    }

    /// Finalize bond based on verification votes
    /// Autonomous execution: anyone can call this once quorum is reached
    pub fn finalize_bond(ctx: Context<FinalizeBond>) -> Result<()> {
        let bond = &mut ctx.accounts.bond;
        let vault_balance = ctx.accounts.bond_vault.lamports();
        
        require!(
            bond.status == BondStatus::PendingVerification ||
            bond.status == BondStatus::Active && Clock::get()?.unix_timestamp > bond.deadline,
            AgberoError::InvalidBondStatus
        );

        let total_votes = bond.verification_votes.len() as u64;
        let approve_votes = bond.verification_votes
            .iter()
            .filter(|v| v.approve)
            .count() as u64;
        let slash_votes = total_votes - approve_votes;

        // Quorum: at least 3 votes, 2/3 majority required
        let quorum_reached = total_votes >= 3;
        let majority_approve = approve_votes * 3 >= total_votes * 2;
        let majority_slash = slash_votes * 3 >= total_votes * 2;

        if quorum_reached && majority_approve {
            // SUCCESS: Release stake to agent
            bond.status = BondStatus::Completed;
            bond.completed_at = Clock::get()?.unix_timestamp;

            // Transfer collateral back to agent
            let bond_key = bond.key();
            let seeds = &[
                b"bond_vault",
                bond_key.as_ref(),
                &[bond.bump],
            ];
            let signer = &[&seeds[..]];

            let cpi_context = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bond_vault.to_account_info(),
                    to: ctx.accounts.agent.to_account_info(),
                },
                signer,
            );
            system_program::transfer(cpi_context, vault_balance)?;

            emit!(BondCompleted {
                bond_id: bond.bond_id.clone(),
                agent: bond.agent,
                stake_released: vault_balance,
            });

            msg!("Bond completed successfully. Stake released.");

        } else if quorum_reached && majority_slash {
            // FAILURE: Slash stake to principal
            bond.status = BondStatus::Slashed;
            bond.completed_at = Clock::get()?.unix_timestamp;

            let bond_key = bond.key();
            let seeds = &[
                b"bond_vault",
                bond_key.as_ref(),
                &[bond.bump],
            ];
            let signer = &[&seeds[..]];

            let cpi_context = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bond_vault.to_account_info(),
                    to: ctx.accounts.principal.to_account_info(),
                },
                signer,
            );
            system_program::transfer(cpi_context, vault_balance)?;

            emit!(BondSlashed {
                bond_id: bond.bond_id.clone(),
                agent: bond.agent,
                principal: bond.principal,
                amount_slashed: vault_balance,
            });

            msg!("Bond slashed! Stake transferred to principal.");

        } else if Clock::get()?.unix_timestamp > bond.deadline + 86400 {
            // Deadline passed + 24hr grace period: auto-slash if no quorum
            bond.status = BondStatus::Slashed;
            bond.completed_at = Clock::get()?.unix_timestamp;

            let bond_key = bond.key();
            let seeds = &[
                b"bond_vault",
                bond_key.as_ref(),
                &[bond.bump],
            ];
            let signer = &[&seeds[..]];

            let cpi_context = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bond_vault.to_account_info(),
                    to: ctx.accounts.principal.to_account_info(),
                },
                signer,
            );
            system_program::transfer(cpi_context, vault_balance)?;

            emit!(BondSlashed {
                bond_id: bond.bond_id.clone(),
                agent: bond.agent,
                principal: bond.principal,
                amount_slashed: vault_balance,
            });

            msg!("Bond auto-slashed due to deadline expiration.");
        } else {
            return Err(AgberoError::QuorumNotReached.into());
        }

        Ok(())
    }

    /// Emergency slash by principal (with delay for agent appeal)
    /// This is for clear-cut scam cases
    pub fn emergency_slash(ctx: Context<EmergencySlash>) -> Result<()> {
        let bond = &mut ctx.accounts.bond;
        
        require!(
            bond.status == BondStatus::Active || bond.status == BondStatus::PendingVerification,
            AgberoError::InvalidBondStatus
        );
        require!(
            ctx.accounts.principal.key() == bond.principal,
            AgberoError::UnauthorizedPrincipal
        );

        // In production: add 24hr appeal window
        // For MVP: immediate slash with reputation penalty

        bond.status = BondStatus::Slashed;
        bond.completed_at = Clock::get()?.unix_timestamp;

        let vault_balance = ctx.accounts.bond_vault.lamports();
        let bond_key = bond.key();
        let seeds = &[
            b"bond_vault",
            bond_key.as_ref(),
            &[bond.bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_context = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.bond_vault.to_account_info(),
                to: ctx.accounts.principal.to_account_info(),
            },
            signer,
        );
        system_program::transfer(cpi_context, vault_balance)?;

        emit!(BondSlashed {
            bond_id: bond.bond_id.clone(),
            agent: bond.agent,
            principal: bond.principal,
            amount_slashed: vault_balance,
        });

        msg!("Emergency slash executed for bond: {}", bond.bond_id);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(bond_id: String)]
pub struct CreateBond<'info> {
    #[account(mut)]
    pub principal: Signer<'info>,
    /// CHECK: Agent pubkey, verified in logic
    pub agent: AccountInfo<'info>,
    
    #[account(
        init,
        payer = principal,
        space = 8 + Bond::MAX_SIZE,
        seeds = [b"bond", bond_id.as_bytes()],
        bump
    )]
    pub bond: Account<'info, Bond>,
    
    #[account(
        init,
        payer = principal,
        space = 8,
        seeds = [b"bond_vault", bond.key().as_ref()],
        bump
    )]
    pub bond_vault: SystemAccount<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StakeCollateral<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    
    #[account(
        mut,
        constraint = bond.agent == agent.key()
    )]
    pub bond: Account<'info, Bond>,
    
    #[account(
        mut,
        seeds = [b"bond_vault", bond.key().as_ref()],
        bump = bond.bump
    )]
    pub bond_vault: SystemAccount<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitProof<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    
    #[account(
        mut,
        constraint = bond.agent == agent.key()
    )]
    pub bond: Account<'info, Bond>,
}

#[derive(Accounts)]
pub struct VerifyWork<'info> {
    pub verifier: Signer<'info>,
    
    #[account(mut)]
    pub bond: Account<'info, Bond>,
}

#[derive(Accounts)]
pub struct FinalizeBond<'info> {
    /// CHECK: Anyone can call to execute autonomously
    pub executor: Signer<'info>,
    
    #[account(mut)]
    pub bond: Account<'info, Bond>,
    
    #[account(
        mut,
        seeds = [b"bond_vault", bond.key().as_ref()],
        bump = bond.bump
    )]
    pub bond_vault: SystemAccount<'info>,
    
    /// CHECK: Agent account for refund
    #[account(mut, address = bond.agent)]
    pub agent: AccountInfo<'info>,
    
    /// CHECK: Principal account for slash payout
    #[account(mut, address = bond.principal)]
    pub principal: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EmergencySlash<'info> {
    #[account(mut)]
    pub principal: Signer<'info>,
    
    #[account(
        mut,
        constraint = bond.principal == principal.key()
    )]
    pub bond: Account<'info, Bond>,
    
    #[account(
        mut,
        seeds = [b"bond_vault", bond.key().as_ref()],
        bump = bond.bump
    )]
    pub bond_vault: SystemAccount<'info>,
    
    /// CHECK: Principal receives slash
    #[account(mut, address = bond.principal)]
    pub principal_vault: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Bond {
    pub bond_id: String,              // 4 + 50
    pub principal: Pubkey,            // 32
    pub agent: Pubkey,                // 32
    pub task_description: String,     // 4 + 500
    pub collateral_amount: u64,       // 8
    pub deadline: i64,                // 8
    pub status: BondStatus,           // 1
    pub created_at: i64,              // 8
    pub completed_at: i64,            // 8
    pub verification_votes: Vec<VerificationVote>, // 4 + (41 * 10)
    pub slash_votes: Vec<SlashVote>,  // 4 + (41 * 10)
    pub proof_uri: String,            // 4 + 200
    pub bump: u8,                     // 1
}

impl Bond {
    pub const MAX_SIZE: usize = 
        4 + 50 +    // bond_id
        32 +        // principal
        32 +        // agent
        4 + 500 +   // task_description
        8 +         // collateral_amount
        8 +         // deadline
        1 +         // status
        8 +         // created_at
        8 +         // completed_at
        4 + (41 * 10) + // verification_votes (max 10)
        4 + (41 * 10) + // slash_votes (max 10)
        4 + 200 +   // proof_uri
        1;          // bump
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum BondStatus {
    Pending,              // Created, waiting for stake
    Active,               // Staked, work in progress
    PendingVerification,  // Proof submitted, awaiting votes
    Completed,            // Work verified, stake released
    Slashed,              // Work failed/scam, stake slashed
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct VerificationVote {
    pub verifier: Pubkey,
    pub approve: bool,
    pub timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SlashVote {
    pub voter: Pubkey,
    pub reason: String,
    pub timestamp: i64,
}

#[error_code]
pub enum AgberoError {
    #[msg("Description too long (max 500 chars)")]
    DescriptionTooLong,
    #[msg("Collateral too low (min 0.001 SOL)")]
    CollateralTooLow,
    #[msg("Invalid deadline")]
    InvalidDeadline,
    #[msg("Invalid bond status")]
    InvalidBondStatus,
    #[msg("Unauthorized agent")]
    UnauthorizedAgent,
    #[msg("Unauthorized principal")]
    UnauthorizedPrincipal,
    #[msg("Agent cannot verify own work")]
    AgentCannotVerify,
    #[msg("Deadline exceeded")]
    DeadlineExceeded,
    #[msg("Proof URI too long")]
    ProofUriTooLong,
    #[msg("Quorum not yet reached")]
    QuorumNotReached,
}

// Events for indexing
#[event]
pub struct BondCreated {
    pub bond_id: String,
    pub principal: Pubkey,
    pub agent: Pubkey,
    pub collateral_amount: u64,
    pub deadline: i64,
}

#[event]
pub struct CollateralStaked {
    pub bond_id: String,
    pub agent: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ProofSubmitted {
    pub bond_id: String,
    pub agent: Pubkey,
    pub proof_uri: String,
}

#[event]
pub struct WorkVerified {
    pub bond_id: String,
    pub verifier: Pubkey,
    pub approve: bool,
}

#[event]
pub struct BondCompleted {
    pub bond_id: String,
    pub agent: Pubkey,
    pub stake_released: u64,
}

#[event]
pub struct BondSlashed {
    pub bond_id: String,
    pub agent: Pubkey,
    pub principal: Pubkey,
    pub amount_slashed: u64,
}
