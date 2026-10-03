#include <iostream>
#include <stack>
#include <unordered_map>
#include <string>
#include <vector>

class Solution {
public:
    bool isValid(std::string s) {
        std::stack<char> st;
        std::unordered_map<char, char> mapping = {
            {')', '('},
            {'}', '{'},
            {']', '['}
        };

        for (char c : s) {
            if (mapping.find(c) != mapping.end()) {
                char topElement = st.empty() ? '#' : st.top();
                if (topElement == mapping[c]) {
                    st.pop();
                } else {
                    return false;
                }
            } else {
                st.push(c);
            }
        }

        return st.empty();
    }
};

int main() {
    Solution solution;
    std::vector<std::pair<std::string, bool>> testCases = {
        {"()", true},
        {"()[]{}", true},
        {"(]", false},
        {"([)]", false},
        {"{[]}", true},
        {"", true},
        {"[", false},
        {"]", false}
    };

    for (const auto& testCase : testCases) {
        bool result = solution.isValid(testCase.first);
        std::cout << "Input: \"" << testCase.first << "\" | Expected: " << (testCase.second ? "true" : "false") 
                  << " | Result: " << (result ? "true" : "false") 
                  << " | " << (result == testCase.second ? "PASS" : "FAIL") << std::endl;
    }

    return 0;
}
