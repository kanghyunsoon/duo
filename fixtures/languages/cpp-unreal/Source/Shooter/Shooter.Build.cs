using UnrealBuildTool;

public class Shooter : ModuleRules
{
    public Shooter(ReadOnlyTargetRules Target) : base(Target)
    {
        PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine" });
    }
}
