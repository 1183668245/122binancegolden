// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "./interfaces/IVaultSchemasV1.sol";

// FLAP 基础规范
abstract contract VaultBase {
    function _getPortal() internal view returns (address portal) {
        uint256 chainId = block.chainid;
        if (chainId == 56) return 0x90497450f2a706f1951b5bdda52B4E5d16f34C06;
        if (chainId == 97) return 0x027e3704fC5C16522e9393d04C60A3ac5c0d775f;
        return address(0);
    }
    function _getGuardian() internal view returns (address guardian) {
        uint256 chainId = block.chainid;
        if (chainId == 56) return 0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b;
        if (chainId == 97) return 0x76Fa8C526f8Bc27ba6958B76DeEf92a0dbE46950;
        return address(0);
    }
    function description() public view virtual returns (string memory);
}

abstract contract VaultBaseV2 is VaultBase {
    function vaultUISchema() public pure virtual returns (VaultUISchema memory schema);
}

contract JackpotVault is VaultBaseV2, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    address public taxToken;
    address public treasury;
    
    uint256 public constant TICKET_PRICE = 20_000 * 10**18;
    uint256 public constant MIN_HOLDING = 500_000 * 10**18;
    uint256 public constant ROUND_DURATION = 15 minutes;
    uint256 public constant LOCK_PERIOD = 30 seconds;
    uint256 public constant HOLDER_RELIEF_MIN_BALANCE = 10_000_000 * 10**18;
    uint256 public constant HOLDER_RELIEF_STREAK = 10;
    uint256 public constant HOLDER_RELIEF_CLAIM_WINDOW = 7 days;

    uint256 public jackpotPool;
    uint256 public fortunePool;
    uint256 public noWinnerStreak;
    uint256 public holderReliefEpochId;
    
    struct Round {
        uint256 startTime;
        uint256 endTime;
        uint16 winningNumber;
        bool resolved;
    }

    struct HolderReliefEpoch {
        uint256 poolAmount;
        uint256 remainingAmount;
        uint256 snapshotBlock;
        uint256 triggeredAt;
        bytes32 merkleRoot;
        uint256 claimDeadline;
    }
    
    uint256 public currentRoundId;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => uint16[])) public userTickets;
    mapping(uint256 => mapping(uint16 => address[])) public numberToUsers;
    mapping(uint256 => address[]) public roundPlayers;
    mapping(uint256 => mapping(address => bool)) public roundPlayerSeen;
    mapping(uint256 => address[]) public dayPlayers;
    mapping(uint256 => mapping(address => bool)) public dayPlayerSeen;
    mapping(uint256 => bool) public dailyFortuneSettled;
    mapping(uint256 => HolderReliefEpoch) public holderReliefEpochs;
    mapping(uint256 => mapping(address => bool)) public holderReliefClaimed;

    struct UserStats {
        uint256 totalWonBNB;
        uint256 totalBurnedToken;
        uint256 fortunePoints;
    }
    mapping(address => UserStats) public stats;
    mapping(address => uint256) public claimableBNB;

    event TaxTokenBound(address indexed taxToken);
    event HolderReliefTriggered(uint256 indexed epochId, uint256 poolAmount, uint256 snapshotBlock);
    event HolderReliefRootUpdated(uint256 indexed epochId, bytes32 merkleRoot);
    event HolderReliefClaimed(uint256 indexed epochId, address indexed user, uint256 amount);
    event TicketBought(uint256 indexed roundId, address indexed player, uint16 number);

    constructor(address _treasury) Ownable(msg.sender) {
        treasury = _treasury;
        currentRoundId = 1;
    }

    receive() external payable {
        uint256 toTreasury = msg.value * 20 / 100;
        (bool success, ) = treasury.call{value: toTreasury}("");
        require(success, "Treasury transfer failed");
        jackpotPool += (msg.value - toTreasury);
    }

    function bindTaxToken(address _taxToken) external onlyOwner {
        require(_taxToken != address(0), "Zero address");
        require(_taxToken.code.length > 0, "Not contract");
        require(taxToken == address(0), "Already bound");
        taxToken = _taxToken;
        rounds[currentRoundId].startTime = block.timestamp;
        rounds[currentRoundId].endTime = block.timestamp + ROUND_DURATION;
        emit TaxTokenBound(_taxToken);
    }

    function buyTicket(uint16 _number) external nonReentrant {
        require(taxToken != address(0), "Tax token not bound");
        require(_number <= 999, "000-999");
        require(block.timestamp < rounds[currentRoundId].endTime - LOCK_PERIOD, "Locked");
        require(IERC20(taxToken).balanceOf(msg.sender) >= MIN_HOLDING, "Hold 500k+");
        require(userTickets[currentRoundId][msg.sender].length < 5, "Max 5");

        uint16[] storage myTickets = userTickets[currentRoundId][msg.sender];
        for (uint256 i = 0; i < myTickets.length; i++) {
            require(myTickets[i] != _number, "Duplicate number");
        }

        IERC20(taxToken).safeTransferFrom(msg.sender, address(0x000000000000000000000000000000000000dEaD), TICKET_PRICE);
        if (!roundPlayerSeen[currentRoundId][msg.sender]) {
            roundPlayerSeen[currentRoundId][msg.sender] = true;
            roundPlayers[currentRoundId].push(msg.sender);
        }
        uint256 dayId = block.timestamp / 1 days;
        if (!dayPlayerSeen[dayId][msg.sender]) {
            dayPlayerSeen[dayId][msg.sender] = true;
            dayPlayers[dayId].push(msg.sender);
        }
        myTickets.push(_number);
        numberToUsers[currentRoundId][_number].push(msg.sender);
        stats[msg.sender].totalBurnedToken += TICKET_PRICE;
        emit TicketBought(currentRoundId, msg.sender, _number);
    }

    function draw() external nonReentrant {
        require(taxToken != address(0), "Tax token not bound");
        require(block.timestamp >= rounds[currentRoundId].endTime, "Not ended");
        require(!rounds[currentRoundId].resolved, "Resolved");

        uint256 seed = uint256(keccak256(abi.encodePacked(
            blockhash(block.number - 1),
            block.timestamp,
            jackpotPool,
            msg.sender
        )));
        
        uint16 winningNumber = uint16(seed % 1000);
        _resolve(winningNumber);
    }

    function _resolve(uint16 _winNum) internal {
        Round storage r = rounds[currentRoundId];
        r.winningNumber = _winNum;
        r.resolved = true;

        uint256 release = jackpotPool * 30 / 100;
        uint256 fortuneShare = release * 10 / 100;
        uint256 prize = release - fortuneShare;
        
        jackpotPool -= release;
        fortunePool += fortuneShare;

        address[] memory potential = numberToUsers[currentRoundId][_winNum];
        uint256 validCount = 0;
        for(uint i=0; i<potential.length; i++) {
            if(IERC20(taxToken).balanceOf(potential[i]) >= MIN_HOLDING) validCount++;
        }
        bool hasWinner = validCount > 0;

        if(hasWinner) {
            uint256 share = prize / validCount;
            uint256 distributed = share * validCount;
            for(uint i=0; i<potential.length; i++) {
                address w = potential[i];
                if(IERC20(taxToken).balanceOf(w) >= MIN_HOLDING) {
                    claimableBNB[w] += share;
                    stats[w].totalWonBNB += share;
                    stats[w].fortunePoints = 0;
                }
            }
            jackpotPool += (prize - distributed); // 余数回流，避免资金尘埃丢失
        } else {
            jackpotPool += prize;
        }

        address[] memory participants = roundPlayers[currentRoundId];
        for (uint256 i = 0; i < participants.length; i++) {
            address p = participants[i];
            if (IERC20(taxToken).balanceOf(p) < MIN_HOLDING) continue;
            uint16[] storage tickets = userTickets[currentRoundId][p];
            bool isWinner = false;
            for (uint256 j = 0; j < tickets.length; j++) {
                if (tickets[j] == _winNum) {
                    isWinner = true;
                    break;
                }
            }
            if (!isWinner && tickets.length > 0) {
                stats[p].fortunePoints += tickets.length;
            }
        }

        if (hasWinner) {
            noWinnerStreak = 0;
        } else {
            noWinnerStreak += 1;
            if (noWinnerStreak >= HOLDER_RELIEF_STREAK) {
                _triggerHolderReliefEpoch();
                noWinnerStreak = 0;
            }
        }

        currentRoundId++;
        rounds[currentRoundId].startTime = block.timestamp;
        rounds[currentRoundId].endTime = block.timestamp + ROUND_DURATION;
    }

    function settleDailyFortune(uint256 dayId) external nonReentrant {
        require(dayId < block.timestamp / 1 days, "Day not ended");
        require(!dailyFortuneSettled[dayId], "Day settled");

        address[] memory players = dayPlayers[dayId];
        address[10] memory top;
        uint256[10] memory topPoints;
        for (uint256 i = 0; i < players.length; i++) {
            address p = players[i];
            if (IERC20(taxToken).balanceOf(p) < MIN_HOLDING) continue;
            uint256 pts = stats[p].fortunePoints;
            if (pts == 0) continue;
            for (uint256 j = 0; j < 10; j++) {
                if (pts > topPoints[j]) {
                    for (uint256 k = 9; k > j; k--) {
                        top[k] = top[k - 1];
                        topPoints[k] = topPoints[k - 1];
                    }
                    top[j] = p;
                    topPoints[j] = pts;
                    break;
                }
            }
        }

        uint256 basePool = fortunePool;
        uint256 distributed;
        if (top[0] != address(0)) { uint256 a = basePool * 20 / 100; claimableBNB[top[0]] += a; distributed += a; }
        if (top[1] != address(0)) { uint256 a = basePool * 15 / 100; claimableBNB[top[1]] += a; distributed += a; }
        if (top[2] != address(0)) { uint256 a = basePool * 10 / 100; claimableBNB[top[2]] += a; distributed += a; }
        uint256 share = basePool * 55 / 100 / 7;
        for (uint256 i = 3; i < 10; i++) {
            if (top[i] == address(0)) break;
            claimableBNB[top[i]] += share;
            distributed += share;
        }

        fortunePool = basePool - distributed;
        dailyFortuneSettled[dayId] = true;
    }

    function setHolderReliefMerkleRoot(uint256 epochId, bytes32 root) external onlyOwner {
        HolderReliefEpoch storage e = holderReliefEpochs[epochId];
        require(e.poolAmount > 0, "Epoch not found");
        require(e.merkleRoot == bytes32(0), "Root already set");
        require(root != bytes32(0), "Zero root");
        e.merkleRoot = root;
        emit HolderReliefRootUpdated(epochId, root);
    }

    function claimHolderRelief(uint256 epochId, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        HolderReliefEpoch storage e = holderReliefEpochs[epochId];
        require(e.poolAmount > 0, "Epoch not found");
        require(block.timestamp <= e.claimDeadline, "Claim ended");
        require(e.merkleRoot != bytes32(0), "Root not set");
        require(!holderReliefClaimed[epochId][msg.sender], "Already claimed");
        require(IERC20(taxToken).balanceOf(msg.sender) >= HOLDER_RELIEF_MIN_BALANCE, "Hold 10m+");
        require(amount > 0 && amount <= e.remainingAmount, "Invalid amount");

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        require(MerkleProof.verify(proof, e.merkleRoot, leaf), "Invalid proof");

        holderReliefClaimed[epochId][msg.sender] = true;
        e.remainingAmount -= amount;
        claimableBNB[msg.sender] += amount;
        emit HolderReliefClaimed(epochId, msg.sender, amount);
    }

    function _triggerHolderReliefEpoch() internal {
        holderReliefEpochId += 1;
        HolderReliefEpoch storage e = holderReliefEpochs[holderReliefEpochId];
        e.poolAmount = jackpotPool;
        e.remainingAmount = jackpotPool;
        e.snapshotBlock = block.number - 1;
        e.triggeredAt = block.timestamp;
        e.claimDeadline = block.timestamp + HOLDER_RELIEF_CLAIM_WINDOW;
        jackpotPool = 0;
        emit HolderReliefTriggered(holderReliefEpochId, e.poolAmount, e.snapshotBlock);
    }

    function claim() external nonReentrant {
        uint256 amount = claimableBNB[msg.sender];
        require(amount > 0, "No prize");
        claimableBNB[msg.sender] = 0;
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Fail");
    }

    function description() public view override returns (string memory) {
        return string(abi.encodePacked("Butterfly Jackpot | Pool: ", _uint2str(jackpotPool/1e18), " BNB"));
    }

    function getPulseDashboard() public view returns (
        uint256 roundId,
        uint256 jackpotPoolWei,
        uint256 fortunePoolWei,
        uint256 endTime,
        uint256 secondsLeft,
        uint8 status,
        address currentTaxToken,
        uint256 streak
    ) {
        Round memory r = rounds[currentRoundId];
        roundId = currentRoundId;
        jackpotPoolWei = jackpotPool;
        fortunePoolWei = fortunePool;
        endTime = r.endTime;
        currentTaxToken = taxToken;
        streak = noWinnerStreak;

        if (taxToken == address(0) || endTime == 0) {
            status = 0;
            secondsLeft = 0;
            return (roundId, jackpotPoolWei, fortunePoolWei, endTime, secondsLeft, status, currentTaxToken, streak);
        }

        if (block.timestamp >= endTime) {
            status = 3;
            secondsLeft = 0;
            return (roundId, jackpotPoolWei, fortunePoolWei, endTime, secondsLeft, status, currentTaxToken, streak);
        }

        uint256 lockTime = endTime > LOCK_PERIOD ? endTime - LOCK_PERIOD : 0;
        if (block.timestamp >= lockTime) {
            status = 2;
            secondsLeft = endTime - block.timestamp;
        } else {
            status = 1;
            secondsLeft = lockTime - block.timestamp;
        }
    }

    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "ButterflyJackpotV2";
        schema.description = "Hold-to-play lottery: draw every 15 minutes; tickets burn tokens; winners split jackpot.";
        schema.methods = new VaultMethodSchema[](5);
        
        schema.methods[0].name = "getPulseDashboard";
        schema.methods[0].description = "Returns the current jackpot round overview for FLAP UI rendering.";
        schema.methods[0].inputs = new FieldDescriptor[](0);
        schema.methods[0].outputs = new FieldDescriptor[](8);
        schema.methods[0].outputs[0] = FieldDescriptor("roundId", "uint256", "Current round id", 0);
        schema.methods[0].outputs[1] = FieldDescriptor("jackpotPoolWei", "uint256", "Current jackpot pool", 18);
        schema.methods[0].outputs[2] = FieldDescriptor("fortunePoolWei", "uint256", "Current fortune pool", 18);
        schema.methods[0].outputs[3] = FieldDescriptor("endTime", "time", "Round end time", 0);
        schema.methods[0].outputs[4] = FieldDescriptor("secondsLeft", "uint256", "Seconds left before state transition", 0);
        schema.methods[0].outputs[5] = FieldDescriptor("status", "uint8", "0=not started, 1=open, 2=locked, 3=awaiting draw", 0);
        schema.methods[0].outputs[6] = FieldDescriptor("currentTaxToken", "address", "Bound FLAP token", 0);
        schema.methods[0].outputs[7] = FieldDescriptor("streak", "uint256", "No winner streak", 0);
        schema.methods[0].approvals = new ApproveAction[](0);

        schema.methods[1].name = "bindTaxToken";
        schema.methods[1].description = "Bind FLAP token address once (owner only).";
        schema.methods[1].inputs = new FieldDescriptor[](1);
        schema.methods[1].inputs[0] = FieldDescriptor("taxToken", "address", "Project token address", 0);
        schema.methods[1].approvals = new ApproveAction[](0);
        schema.methods[1].isWriteMethod = true;

        schema.methods[2].name = "buyTicket";
        schema.methods[2].description = "Buy one ticket (000-999)";
        schema.methods[2].inputs = new FieldDescriptor[](1);
        schema.methods[2].inputs[0] = FieldDescriptor("number", "uint16", "Ticket number", 0);
        schema.methods[2].approvals = new ApproveAction[](1);
        schema.methods[2].approvals[0] = ApproveAction("taxToken", "TICKET_PRICE");
        schema.methods[2].isWriteMethod = true;

        schema.methods[3].name = "draw";
        schema.methods[3].description = "Draw (available after round ends)";
        schema.methods[3].isWriteMethod = true;

        schema.methods[4].name = "claim";
        schema.methods[4].description = "Claim prize";
        schema.methods[4].isWriteMethod = true;
    }

    function _uint2str(uint256 _i) internal pure returns (string memory) {
        if (_i == 0) return "0";
        uint256 j = _i; uint256 len;
        while (j != 0) { len++; j /= 10; }
        bytes memory bstr = new bytes(len);
        uint256 k = len;
        while (_i != 0) {
            k = k - 1;
            bstr[k] = bytes1(uint8(48 + uint8(_i - (_i / 10) * 10)));
            _i /= 10;
        }
        return string(bstr);
    }
}