# Commands Reference

## 👤 User Commands

### General

`/deal` - Start a new trade (tag a user)
`/verify <address>` - Check a wallet address
`/stats` - View your stats
`/stats @username` - View another user's stats
`/leaderboard` - View top traders

### Active Trade Group

`/balance` - Check trade balance
`/add` - Add more funds/Top-up (after deposit)
`/release` - Seller releases funds to buyer
`/dispute <reason>` - Report a problem
`/cancel` - Cancel trade (if not yet deposited)
`/restart` - Restart trade (if not yet deposited)

---

## 🔧 Admin Commands

### Groups & Pools

`/admin_pool` - View pool status
`/admin_pool_add <groupId>` - Add group to pool
`/admin_pool_list` - List all groups
`/admin_pool_delete <groupId>` - Remove group from pool
`/admin_group_reset` - Force reset current group
`/admin_reset_force` - Force reset group (any status)
`/admin_reset_all_groups` - Reset ALL groups (Emergency)

### Address Pool

`/admin_address_pool` - View address pool status
`/admin_init_addresses` - Create/Replenish addresses
`/admin_cleanup_addresses` - Recycle unused addresses

### Trade Management (Force Actions)

`/release` - Force release to buyer
`/release <amount>` - Force partial release
`/refund` - Force refund to seller
`/refund <amount>` - Force partial refund
`/restart` - Force restart trade

### Statistics

`/admin_stats` - View system-wide stats
`/admin_trade_stats` - View stats by fee
`/admin_recent_trades` - View recent activity
`/admin_export_trades` - Download CSV report

### System

`/withdraw_all_bsc` - Withdraw all fees & surplus (BSC)
`/withdraw_all_tron` - Withdraw all fees & surplus (TRON)
`/withdraw_room_X` - Withdraw all funds from MM Room X (e.g., `/withdraw_room_10`)
`/admin_help` - Show this list

---

## 🤖 Automatic Features

- **Recycling**: Groups clear 15m after trade ends.
- **Monitoring**: Deposits & status updates are automatic.
- **Logging**: Completed trades post to the feed channel.
- **Alerts**: Disputes notify admins immediately.
