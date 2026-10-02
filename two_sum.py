from typing import List


class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        """
        Given an array of integers nums and an integer target, return indices
        of the two numbers such that they add up to target.

        Time Complexity: O(n)
        Space Complexity: O(n)
        """
        seen: dict[int, int] = {}
        for index, num in enumerate(nums):
            complement = target - num
            if complement in seen:
                return [seen[complement], index]
            seen[num] = index
        return []


if __name__ == "__main__":
    solution = Solution()

    # Test cases
    test_cases = [
        ([2, 7, 11, 15], 9, [0, 1]),
        ([3, 2, 4], 6, [1, 2]),
        ([3, 3], 6, [0, 1]),
    ]

    for nums, target, expected in test_cases:
        result = solution.twoSum(nums, target)
        assert result == expected, f"Failed for {nums}, target={target}: expected {expected}, got {result}"
        print(f"nums={nums}, target={target} -> {result}")

    print("All tests passed successfully!")
