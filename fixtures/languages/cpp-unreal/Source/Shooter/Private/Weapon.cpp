#include "Weapon.h"

static int32 ClampRounds(int32 Requested, int32 Available)
{
    return Requested < Available ? Requested : Available;
}

int32 AWeapon::Fire(int32 Requested)
{
    const int32 Fired = ClampRounds(Requested, Ammo);
    Ammo -= Fired;
    return Fired;
}
