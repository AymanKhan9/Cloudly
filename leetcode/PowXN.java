public class PowXN {
    public double myPow(double x, int n) {
        long N = n;
        if (N < 0) {
            x = 1 / x;
            N = -N;
        }
        double ans = 1;
        double currentProduct = x;
        for (long i = N; i > 0; i /= 2) {
            if ((i % 2) == 1) {
                ans = ans * currentProduct;
            }
            currentProduct = currentProduct * currentProduct;
        }
        return ans;
    }

    public static void main(String[] args) {
        PowXN sol = new PowXN();
        
        // Test cases
        double[][] tests = {
            {2.00000, 10, 1024.00000},
            {2.10000, 3, 9.26100},
            {2.00000, -2, 0.25000}
        };

        for (double[] test : tests) {
            double x = test[0];
            int n = (int) test[1];
            double expected = test[2];
            double result = sol.myPow(x, n);
            System.out.printf("myPow(%.5f, %d) = %.5f (Expected: %.5f) - %s%n", 
                x, n, result, expected, Math.abs(result - expected) < 1e-5 ? "PASSED" : "FAILED");
        }
    }
}
