using UnityEngine;

namespace Arena
{
    public class PlayerHealth : MonoBehaviour
    {
        public int Current { get; private set; } = 100;

        public void TakeDamage(int amount)
        {
            Current = Clamp(Current - amount);
        }

        private static int Clamp(int value)
        {
            return value < 0 ? 0 : value;
        }
    }
}
