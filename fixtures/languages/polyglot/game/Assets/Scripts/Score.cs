namespace Storefront.Game
{
    public class Score
    {
        public int CartTotal(int[] items)
        {
            var sum = 0;
            foreach (var i in items) sum += i;
            return sum;
        }
    }
}
