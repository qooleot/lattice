import edu.mit.csail.sdg.alloy4.A4Reporter;
import edu.mit.csail.sdg.ast.Command;
import edu.mit.csail.sdg.ast.Func;
import edu.mit.csail.sdg.parser.CompModule;
import edu.mit.csail.sdg.parser.CompUtil;
import edu.mit.csail.sdg.translator.A4Options;
import edu.mit.csail.sdg.translator.A4Solution;
import edu.mit.csail.sdg.translator.TranslateAlloyToKodkod;
import kodkod.engine.satlab.SATFactory;
import java.util.Collections;

/** Usage: AlloyRunner <file.als> <maxInstances> <outDir>
 *  Runs the first command; writes inst_<i>.xml per instance; prints "INSTANCES n" or "UNSAT". */
public class AlloyRunner {
  public static void main(String[] args) throws Exception {
    CompModule world = CompUtil.parseEverything_fromFile(A4Reporter.NOP, null, args[0]);
    int max = Integer.parseInt(args[1]);
    String outDir = args[2];
    Command cmd = world.getAllCommands().get(0);
    A4Options opts = new A4Options();
    // Alloy 6.2.0 dropped the A4Options.SatSolver enum; A4Options.solver is now a
    // kodkod.engine.satlab.SATFactory directly. SATFactory.DEFAULT already resolves
    // to the bundled sat4j, but we look it up by id explicitly for determinism.
    opts.solver = SATFactory.find("sat4j").orElse(SATFactory.DEFAULT);
    A4Solution sol = TranslateAlloyToKodkod.execute_command(A4Reporter.NOP, world.getAllReachableSigs(), cmd, opts);
    int n = 0;
    while (sol.satisfiable() && n < max) {
      // The 1-arg writeXML(String) overload in this jar build internally passes a
      // null Iterable<Func> down to A4SolutionWriter, which NPEs while iterating
      // "extraSkolems". Pass an explicit empty list via the 2-arg overload instead.
      sol.writeXML(outDir + "/inst_" + n + ".xml", Collections.<Func>emptyList());
      n++;
      sol = sol.next();
    }
    System.out.println(n == 0 ? "UNSAT" : ("INSTANCES " + n));
  }
}
