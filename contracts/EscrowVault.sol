// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract EscrowVault {
    address public owner;
    address public immutable token;
    address public feeWallet;

    event Released(address indexed to, uint256 amount);
    event Refunded(address indexed to, uint256 amount);
    event FeeWalletUpdated(address wallet);

    modifier onlyOwner() {
        require(msg.sender == owner, "not-owner");
        _;
    }

    constructor(address _token, address _feeWallet) {
        owner = msg.sender;
        token = _token;
        feeWallet = _feeWallet;
    }

    function setOwner(address _owner) external onlyOwner {
        owner = _owner;
    }

    function setFeeWallet(address _feeWallet) external onlyOwner {
        feeWallet = _feeWallet;
        emit FeeWalletUpdated(_feeWallet);
    }

    function release(address to, uint256 amount) external onlyOwner {
        _safeTransfer(token, to, amount);
        emit Released(to, amount);
    }

    function refund(address to, uint256 amount) external onlyOwner {
        _safeTransfer(token, to, amount);
        emit Refunded(to, amount);
    }

    function withdrawToken(address erc20Token, address to) external onlyOwner {
        require(to != address(0), "zero-to");
        uint256 bal = IERC20(erc20Token).balanceOf(address(this));
        require(bal > 0, "no-balance");
        _safeTransfer(erc20Token, to, bal);
    }

    function _safeTransfer(
        address token_,
        address to,
        uint256 amount
    ) internal {
        (bool success, bytes memory data) = token_.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        require(
            success && (data.length == 0 || abi.decode(data, (bool))),
            "TRANSFER_FAILED"
        );
    }
}
