using NUnit.Framework;
using UnityEngine;

namespace Arena.Tests
{
    public class PlayerHealthTests
    {
        [Test]
        public void HealthNeverDropsBelowZero()
        {
            var player = new GameObject().AddComponent<PlayerHealth>();
            player.TakeDamage(500);
            Assert.AreEqual(0, player.Current);
        }
    }
}
