// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

contract EscrowVault {
    address public owner;
    IERC20 public immutable token; // USDT (BEP-20)

    // Fee wallet (100% of fees)
    address public feeWallet;
    // feePercent in basis points (e.g., 100 = 1.00%)
    uint256 public feePercent;

    // Accumulate fees in contract
    uint256 public accumulatedFees;

    event Released(
        address indexed to,
        uint256 grossAmount,
        uint256 netAmount,
        uint256 feeAmount
    );
    event Refunded(
        address indexed to,
        uint256 grossAmount,
        uint256 netAmount,
        uint256 feeAmount
    );
    event FeesWithdrawn(uint256 amount, address wallet);
    event FeeWalletUpdated(address wallet);
    event FeePercentUpdated(uint256 feePercent);

    modifier onlyOwner() {
        require(msg.sender == owner, "not-owner");
        _;
    }

    constructor(address _token, address _feeWallet, uint256 _feePercent) {
        owner = msg.sender;
        token = IERC20(_token);
        feeWallet = _feeWallet;
        feePercent = _feePercent; // 100 = 1%
    }

    function setOwner(address _owner) external onlyOwner {
        owner = _owner;
    }

    function setFeeWallet(address _feeWallet) external onlyOwner {
        feeWallet = _feeWallet;
        emit FeeWalletUpdated(_feeWallet);
    }

    function setFeePercent(uint256 _feePercent) external onlyOwner {
        require(_feePercent <= 1000, "too-high"); // <= 10%
        feePercent = _feePercent;
        emit FeePercentUpdated(_feePercent);
    }

    function withdrawFees() external onlyOwner {
        uint256 fee = accumulatedFees;
        require(fee > 0, "no-fees");

        accumulatedFees = 0; // Reset before transfer

        require(token.transfer(feeWallet, fee), "fee-fail");

        emit FeesWithdrawn(fee, feeWallet);
    }

    function release(address to, uint256 amount) external onlyOwner {
        uint256 fee = (amount * feePercent) / 10000; // basis points
        uint256 net = amount - fee;

        accumulatedFees += fee; // Store fee in contract

        require(token.transfer(to, net), "transfer-fail");
        emit Released(to, amount, net, fee);
    }

    function refund(address to, uint256 amount) external onlyOwner {
        uint256 fee = (amount * feePercent) / 10000;
        uint256 net = amount - fee;

        accumulatedFees += fee; // Store fee in contract

        require(token.transfer(to, net), "transfer-fail");
        emit Refunded(to, amount, net, fee);
    }

    // Owner utility: sweep any ERC-20 token balance to a specified address
    function withdrawToken(address erc20Token, address to) external onlyOwner {
        require(to != address(0), "zero-to");
        IERC20 t = IERC20(erc20Token);
        uint256 bal = t.balanceOf(address(this));
        require(bal > 0, "no-balance");
        require(t.transfer(to, bal), "sweep-fail");
    }
}
