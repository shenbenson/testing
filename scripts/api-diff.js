const fs = require('fs');

// Helper function to calculate path similarity
function calculatePathSimilarity(path1, path2) {
    const segments1 = path1.split('/').filter(Boolean);
    const segments2 = path2.split('/').filter(Boolean);
    
    // If the paths have very different structures, they're probably not related
    if (Math.abs(segments1.length - segments2.length) > 1) {
        return 0;
    }
    
    let matches = 0;
    const maxLength = Math.max(segments1.length, segments2.length);
    
    // Compare segments
    for (let i = 0; i < Math.min(segments1.length, segments2.length); i++) {
        if (segments1[i] === segments2[i]) {
            matches++;
        }
    }
    
    return matches / maxLength;
}

// Read the JSON files
const previousSpec = JSON.parse(fs.readFileSync('previous.json', 'utf8'));
const currentSpec = JSON.parse(fs.readFileSync('current.json', 'utf8'));

// Initialize change tracking
const changes = {
    added: {},      // Group by path
    removed: {},    // Group by path
    modified: {},   // Group by path
    components: new Set(),  // Track changed components
    affectedByComponents: {} // Track paths affected by component changes
};

// Helper function to track component references
function findComponentRefs(obj, components) {
    if (!obj) return;
    if (typeof obj === 'object') {
        if (obj['$ref'] && obj['$ref'].startsWith('#/components/')) {
            components.add(obj['$ref'].split('/').pop());
        }
        Object.values(obj).forEach(value => findComponentRefs(value, components));
    }
}

// Compare components first
function compareComponents() {
    const prevComps = previousSpec.components || {};
    const currComps = currentSpec.components || {};
    
    for (const [category, components] of Object.entries(currComps)) {
        for (const [name, def] of Object.entries(components)) {
            if (!prevComps[category]?.[name] || 
                JSON.stringify(prevComps[category][name]) !== JSON.stringify(def)) {
                changes.components.add(name);
            }
        }
    }
}

// Find paths affected by component changes
function findAffectedPaths() {
    if (changes.components.size === 0) return;

    Object.entries(currentSpec.paths || {}).forEach(([path, methods]) => {
        const affectedMethods = [];
        Object.entries(methods).forEach(([method, details]) => {
            const usedComponents = new Set();
            findComponentRefs(details, usedComponents);
            
            for (const comp of usedComponents) {
                if (changes.components.has(comp)) {
                    affectedMethods.push(method.toUpperCase());
                    if (!changes.affectedByComponents[path]) {
                        changes.affectedByComponents[path] = {
                            methods: new Set(),
                            components: new Set()
                        };
                    }
                    changes.affectedByComponents[path].methods.add(method.toUpperCase());
                    changes.affectedByComponents[path].components.add(comp);
                }
            }
        });
    });
}

// Compare paths and methods
function comparePaths() {
    // console.log('Current paths:', Object.keys(currentSpec.paths || {}));
    // console.log('Previous paths:', Object.keys(previousSpec.paths || {}));
    
    // Check for added and modified endpoints
    Object.entries(currentSpec.paths || {}).forEach(([path, methods]) => {
        const previousMethods = previousSpec.paths?.[path] || {};
        
        Object.entries(methods).forEach(([method, details]) => {
            if (!previousMethods[method]) {
                // console.log(`Found new method: ${method} for path: ${path}`);
                if (!changes.added[path]) changes.added[path] = new Set();
                changes.added[path].add(method.toUpperCase());
            } else if (JSON.stringify(previousMethods[method]) !== JSON.stringify(details)) {
                if (!changes.modified[path]) changes.modified[path] = new Set();
                changes.modified[path].add({
                    method: method.toUpperCase(),
                    changes: getChanges(previousMethods[method], details)
                });
            }
        });
    });

    // Check for removed endpoints
    Object.entries(previousSpec.paths || {}).forEach(([path, methods]) => {
        Object.keys(methods).forEach(method => {
            if (!currentSpec.paths?.[path]?.[method]) {
                if (!changes.removed[path]) changes.removed[path] = new Set();
                changes.removed[path].add(method.toUpperCase());
            }
        });
    });
}

function getChanges(previous, current) {
    const changes = [];
    const fields = ['summary', 'description', 'operationId', 'parameters', 'requestBody', 'responses'];
    
    fields.forEach(field => {
        if (JSON.stringify(previous[field]) !== JSON.stringify(current[field])) {
            changes.push(field);
        }
    });
    
    return changes;
}

// Helper function to detect where a component is used in an endpoint
function findComponentUsage(details, componentName) {
    const usage = [];
    
    // Check parameters
    if (details.parameters) {
        const hasComponent = details.parameters.some(p => 
            (p.$ref && p.$ref.includes(componentName)) ||
            (p.schema && p.schema.$ref && p.schema.$ref.includes(componentName))
        );
        if (hasComponent) usage.push('parameters');
    }
    
    // Check requestBody
    if (details.requestBody && 
        details.requestBody.content && 
        Object.values(details.requestBody.content).some(c => 
            c.schema && c.schema.$ref && c.schema.$ref.includes(componentName))) {
        usage.push('requestBody');
    }
    
    // Check responses
    if (details.responses && 
        Object.values(details.responses).some(r => 
            r.content && Object.values(r.content).some(c => 
                c.schema && c.schema.$ref && c.schema.$ref.includes(componentName)))) {
        usage.push('responses');
    }
    
    return usage;
}

// Generate markdown release notes
function generateReleaseNotes() {
    let releaseNotes = '# API Changes\n\n';
    
    // Find renamed endpoints (those that appear in both added and removed)
    const renamed = {};
    // console.log('Before rename detection - Added paths:', Object.keys(changes.added));
    const addedEntries = Object.entries(changes.added);
    Object.entries(changes.removed).forEach(([removedPath, removedMethods]) => {
        addedEntries.forEach(([addedPath, addedMethods]) => {
            // Calculate path similarity
            const pathSimilarity = calculatePathSimilarity(removedPath, addedPath);
            // console.log(`Checking similarity between ${removedPath} and ${addedPath}: ${pathSimilarity}`);
            
            // If methods match and paths are similar enough, likely a rename
            if (addedMethods && removedMethods && 
                JSON.stringify([...removedMethods].sort()) === JSON.stringify([...addedMethods].sort()) &&
                pathSimilarity >= 0.7) { // 70% similarity threshold
                // console.log(`Detected rename: ${removedPath} → ${addedPath}`);
                renamed[removedPath] = {
                    newPath: addedPath,
                    methods: [...addedMethods] // Store methods before deleting
                };
                // Remove from added and removed
                delete changes.added[addedPath];
                delete changes.removed[removedPath];
            }
        });
    });

    const sections = [];

    // Added endpoints
    if (Object.keys(changes.added).length > 0) {
        let section = '## Added\n';
        Object.entries(changes.added)
            .sort(([a], [b]) => a.localeCompare(b))
            .forEach(([path, methods]) => {
                section += `- [${Array.from(methods).sort().join('] [')}] \`${path}\`\n`;
            });
        sections.push(section);
    }

    // Modified endpoints
    if (Object.keys(changes.modified).length > 0 || Object.keys(changes.affectedByComponents).length > 0) {
        let section = '## Modified\n';
        
        // Combine and sort all modified paths
        const allModifiedPaths = new Set([
            ...Object.keys(changes.modified),
            ...Object.keys(changes.affectedByComponents)
        ]);

        Array.from(allModifiedPaths)
            .sort()
            .forEach(path => {
                // Direct modifications
                if (changes.modified[path]) {
                    // Sort method changes alphabetically
                    Array.from(changes.modified[path])
                        .sort((a, b) => a.method.localeCompare(b.method))
                        .forEach(({method, changes}) => {
                            section += `- [${method}] \`${path}\`\n`;
                            changes.sort().forEach(change => {
                                section += `  - ${change}\n`;
                            });
                        });
                }

                // Component-affected paths
                if (changes.affectedByComponents[path] && !changes.modified[path]) {
                    Array.from(changes.affectedByComponents[path].methods)
                        .sort()
                        .forEach(method => {
                            section += `- [${method}] \`${path}\`\n`;
                            Array.from(changes.affectedByComponents[path].components)
                                .sort()
                                .forEach(component => {
                                    const methodDetails = currentSpec.paths[path][method.toLowerCase()];
                                    const usageLocations = findComponentUsage(methodDetails, component).sort();
                                    section += `  - \`${component}\` modified in ${usageLocations.join(', ')}\n`;
                                });
                        });
                }
            });
        sections.push(section);
    }

    // Removed endpoints
    if (Object.keys(changes.removed).length > 0) {
        let section = '## Removed\n';
        Object.entries(changes.removed)
            .sort(([a], [b]) => a.localeCompare(b))
            .forEach(([path, methods]) => {
                section += `- [${Array.from(methods).sort().join('] [')}] \`${path}\`\n`;
            });
        sections.push(section);
    }

    // Renamed endpoints
    if (Object.keys(renamed).length > 0) {
        let section = '## Renamed\n';
        Object.entries(renamed)
            .sort(([a], [b]) => a.localeCompare(b))
            .forEach(([oldPath, {newPath, methods}]) => {
                section += `- [${methods.sort().join('] [')}] \`${oldPath}\` → \`${newPath}\`\n`;
            });
        sections.push(section);
    }

    // Sort sections alphabetically and combine
    sections.sort((a, b) => {
        const titleA = a.split('\n')[0];
        const titleB = b.split('\n')[0];
        return titleA.localeCompare(titleB);
    });

    releaseNotes += sections.join('\n');

    return releaseNotes;
}

// Main execution
compareComponents();
findAffectedPaths();
comparePaths();
const releaseNotes = generateReleaseNotes();

// Write release notes to markdown file
fs.writeFileSync('release-notes.md', releaseNotes);
