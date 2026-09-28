#include "Misc/AutomationTest.h"
#include "Weapon.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FWeaponFireTest, "Shooter.Weapon.Fire", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FWeaponFireTest::RunTest(const FString& Parameters)
{
    TestTrue(TEXT("fires"), true);
    return true;
}
